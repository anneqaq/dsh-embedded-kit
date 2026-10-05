---
name: fault-diagnosis
description: Cortex-M 异常分诊方法论：故障类型与升级链、寄存器含义、现场保存流程、按证据分诊的决策树、栈溢出与跑飞的判别、以及看门狗复位与硬故障的区分
whenToUse: 出现 HardFault / 死机 / 看门狗复位 / 随机重启时；需要从故障栈定位到源码位置时；设计故障处理与现场保存机制时
---

# Cortex-M 异常分诊

## 一、先分清"故障"与"复位"

**这两类的排查路径完全不同，先分清再动手。**

| 现象 | 判别依据 | 含义 |
|---|---|---|
| HardFault | 停在 HardFault_Handler 里 | 程序跑到了非法状态，**PC 有明确位置** |
| 看门狗复位 | 复位后读 RCC/RCU 的复位标志（如 IWDG/WWDG 标志） | 程序卡住了但**没跑飞**，多半是死等某个标志/死锁 |
| 上电复位 | 复位标志显示 POR | 电源问题或真的断电 |
| 软件复位 | 复位标志显示 SW | 有意复位（如升级跳转） |

**第一步永远是：复位后立刻读并保存复位标志**，否则下次上电就把证据冲掉了。
没有这一步，你只能靠猜。

## 二、异常升级链（为什么"明明是内存错误却报 HardFault"）

Cortex-M 的故障有多级：

```
UsageFault / BusFault / MemManageFault
        │  （未使能，或优先级不足）
        ▼
      HardFault
```

- 默认情况下手、多数工程**根本没使能** UsageFault 与 BusFault，于是所有故障都被拉成 HardFault。
- 此时判断依据是 **HFSR.FORCED = 1**：说明"这是一次被升级的故障"，**根因在 CFSR**。
- **实践建议**：调试期把 `SCB->SHCSR` 的 USGFAULTENA / BUSFAULTENA / MEMFAULTENA 都打开，
  让故障停在**最靠近根因的那个处理函数**里。这一步能把排查时间砍掉一大半。

## 三、必须保存的现场

在 HardFault_Handler 里，**第一件事是保存现场**，越早越好（后面的代码可能再次出错）：

```c
__attribute__((naked)) void HardFault_Handler(void)
{
    __asm volatile (
        "tst   lr, #4          \n"   /* LR 的 bit2 = 0 → 用 MSP；= 2 → 用 PSP */
        "ite   eq              \n"
        "mrseq r0, msp         \n"
        "mrsne r0, psp         \n"
        "b     hardfault_report\n"
    );
}

/* r0 = 指向异常入栈的帧：r0 r1 r2 r3 r12 LR PC xPSR（若带 FPU 且用了浮点，后面还有 S0-S15/FPSCR） */
void hardfault_report(uint32_t *frame)
{
    volatile uint32_t cfsr  = SCB->CFSR;
    volatile uint32_t hfsr  = SCB->HFSR;
    volatile uint32_t mmfar = SCB->MMFAR;
    volatile uint32_t bfar  = SCB->BFAR;
    /* 存进不随复位清零的备份寄存器 / 未初始化且不被启动代码清零的 RAM 段 */
    g_fault.pc = frame[6]; g_fault.lr = frame[5]; g_fault.psr = frame[7];
    g_fault.cfsr = cfsr; g_fault.hfsr = hfsr; g_fault.mmfar = mmfar; g_fault.bfar = bfar;
    for (;;) { }
}
```

要点：
- **`tst lr, #4`** 判断用哪个栈。`EXC_RETURN` 的位决定 `MSP` 还是 `PSP`；
  **FreeRTOS 任务里出错时帧在 PSP 上，读 MSP 只会读到内核栈**。
- 现场必须存到**复位不清零**的地方：备份寄存器域，或链接脚本里专门划出的 `NOINIT` 段
  （注意启动代码通常会清零 `.bss`，所以不能用普通全局变量的初值语义）。
- **带 FPU 的核**：若 `EXC_RETURN` 属于扩展帧（0xFFFFFFE1/E9/ED），栈帧多 104 字节。
  取错偏移读到的全是错位数据 —— 这个判断交给 `fault_decode` 做，别自己算位。

## 四、分诊决策树（按证据强弱走）

拿到现场后，**用 `fault_decode` 跑一遍**（传 ELF 文件可把 PC 翻译成函数名 + 偏移），然后按下面的顺序看：

1. **LR 是不是合法的 EXC_RETURN？** 不是 → **栈帧已被破坏**（栈溢出、缓冲区溢出覆盖了栈），
   后面的寄存器值都不可信，先去查栈。
2. **PC 落在哪个区域？**
   - 在 RAM 里 → 程序跑飞（返回地址被覆盖）。查栈溢出与数组越界。
   - 不在任何已知区域 → 跳到了野地址。查函数指针、回调表、中断向量表。
   - PC = 0 或接近 0xFFFFFFF0 → 空指针调用 / 未初始化指针。
3. **xPSR 的 T 位（bit24）为 0？** → **INVSTATE**：用 `bx`/函数指针跳到了偶地址。
   Cortex-M 只执行 Thumb，函数指针最低位必须为 1。
4. **CFSR 里是哪个域？**
   - `MSTKERR`/`STKERR` → **异常入栈失败，首要怀疑栈溢出或 SP 非法**。
   - `UNALIGNED` → 非对齐访问（M0/M0+ 直接硬错误）。
   - `DIVBYZERO` → 除零（需打开 CCR 的陷阱）。
   - `IMPRECISERR` → **非精确总线错误：PC 指向的指令不是根因**，要往前找；
     或先关写缓冲/加屏障让错误变精确。
   - `PRECISERR` → 精确总线错误，**看 BFAR 给出的地址**：访问了未使能时钟的外设或未映射地址。
5. **HFSR.FORCED = 1？** → 这是被升级的故障，根因看 CFSR，别盯着 HardFault 本身。

**证据不足时不要下结论。** 只有一个 PC 而没有 CFSR，最多只能说"PC 在这里"，
不能说"原因是 XX" —— 这是分诊里最常见的过度推断。

## 五、栈溢出的判别（最常见、也最容易漏）

- **裸机**：栈区预填魔数（如 `0xA5A5A5A5`），跑一轮最坏路径后**扫描未被改写的边界**得到实际栈深。
- **RTOS**：`uxTaskGetStackHighWaterMark()`。
- **中断上下文也可能溢出**：中断嵌套会额外吃掉一层栈帧（每层约 32 字节 + 处理函数自身的栈）。
  计算最坏栈深时要把**最深中断嵌套**算进去。
- 典型症状：偶发、和调用深度相关、加了局部大数组后开始出现。

## 六、看门狗复位 vs 硬故障

- 看门狗复位**没有 PC 现场** —— 它是在程序还"活着"但没喂狗时触发的。所以：
  **不要把看门狗复位当成硬故障去查 CFSR**（那里面是空的或旧的）。
- 排查看门狗复位要找**卡在哪里**：在可疑的等待循环里翻转一个 GPIO，用逻辑分析仪看最后停在哪；
  或分配一个"进度变量"，复位后读它知道走到哪一步。
- **喂狗点必须在主循环的正常路径上**。放在定时器中断里喂，等于主循环死了狗也照样被喂，看门狗形同虚设。

## 七、让下次更好查

- 固定输出格式：一条日志或一段备份寄存器里放**复位标志 + PC + LR + CFSR + HFSR**，
  比每次人工读寄存器快一个数量级。
- 保留一份**带符号表的 ELF**（不要只留 hex/bin），否则 PC 翻译不了。
- 调试期打开 USG/BUS/MEM 故障使能，让故障停在根因处。
- 对已知的"偶发"故障，加**故障注入**主动复现（见 `debug-methodology`），别等它自己出现。
