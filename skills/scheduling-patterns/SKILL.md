---
name: scheduling-patterns
description: 嵌入式调度范式：状态机设计、多定时器分时调度、定时器+中断调度三者的选择与实现，含相位错开、节拍碰撞、时间基准与常见陷阱
whenToUse: 设计或重构固件的执行结构时；多任务共用定时器时；状态机写得乱、隐式状态遍地时；需要判断该用裸机调度还是上 RTOS 时
---

# 嵌入式调度范式

## 第 0 步：先决定用哪种结构，再写代码

结构选错，后面怎么改都是补丁。按**复杂度与实时性要求**选：

| 结构 | 适用 | 不适用 |
|---|---|---|
| **主循环 + 状态机** | 单线程、事件驱动、状态清晰（家电、仪表、单通讯口） | 有硬实时多任务、有阻塞操作 |
| **多定时器分时（节拍调度）** | 多个周期性任务、无抢占要求、裸机 | 任务耗时不可预测、需要优先级抢占 |
| **定时器 + 中断调度** | 少量高实时性事件（编码器、脉冲、通讯字节流） | 中断里做长活儿（会拖垮一切） |
| **RTOS（FreeRTOS 等）** | 任务多、需要阻塞语义与优先级抢占、有栈可开 | 4KB 级 RAM 的 M0、任务数 2~3 个的简单场景 |

**先用 `sched_analyze` 算一遍再决定**：把节拍和各任务的周期/最坏执行时间输进去，看 CPU 占用率与最坏一拍能否跑完。不要写完代码才发现排不下。

---

## 一、状态机

### 1.1 显式化是唯一的原则

**状态必须是显式的、集中的、可枚举的。** 用一堆 `bool` 拼出来的"隐式状态"是最常见的技术债：

```c
/* 反例：组合出 2^4 种状态，其中大半非法，且没人知道当前到底在哪个状态 */
bool connecting, connected, waiting_ack, timed_out;
```

```c
/* 正例：状态可枚举，非法组合在类型层面就不存在 */
typedef enum { ST_IDLE, ST_CONNECTING, ST_CONNECTED, ST_WAIT_ACK, ST_ERROR } state_t;
static state_t s_state = ST_IDLE;   /* 只此一处持有状态 */
```

### 1.2 两种实现形态

**switch 形态**（状态少、迁移简单，可读性最好）：

```c
static void fsm_step(event_t ev)
{
    const uint32_t now = tick_ms();
    switch (s_state) {
    case ST_IDLE:
        if (ev == EV_START) { send_connect(); s_t0 = now; s_state = ST_CONNECTING; }
        break;
    case ST_CONNECTING:
        if (ev == EV_ACK)                    s_state = ST_CONNECTED;
        else if (elapsed(now, s_t0) > 2000u) s_state = ST_ERROR;   /* 超时必须带 */
        break;
    /* ... */
    default: s_state = ST_ERROR; break;    /* 未处理状态一律进错误态，不要静默停在原地 */
    }
}
```

**表驱动形态**（状态多、迁移规则规整、需要统一加日志/统计时）：

```c
typedef void (*action_fn)(void);
typedef struct { state_t next; action_fn on_entry; } trans_t;
/* 二维表：[当前状态][事件] → 迁移；空白项为 NULL 表示忽略该事件 */
static const trans_t TABLE[ST_MAX][EV_MAX] = { /* ... */ };
```

**选择判据**：迁移条目超过 ~20 条、或需要统一加埋点与统计时，用表驱动；否则 switch 更好读。

### 1.3 状态机必备的四件事

1. **超时**：每个"等待型"状态都要有超时出口。状态机最常见的挂死就是等一个永远不来的事件。
2. **进入/退出动作集中**：`on_entry` 里做初始化（清计数器、置引脚、起定时器），避免在别处零散地改状态相关变量。
3. **事件队列而不是直接调用**：事件从 ISR 进来时只入队，由状态机在主循环里消费 —— 这样状态机永远在同一个上下文里执行，不用考虑重入。
4. **可观测**：留一个"当前状态"的查询接口，调试时能直接看（串口打印 / 调试变量 / `sched_analyze` 之外的运行期观察）。

### 1.4 常见错误

- **状态迁移写在多个函数里**：状态被分散修改，出问题时找不到"谁把它改了"。
- **ISR 里直接改状态**：与主循环竞态。ISR 只投递事件。
- **忘记处理未定义事件**：`switch` 没有 `default`，新加事件后静默无行为。
- **把状态与状态相关数据分开维护**：状态是 A 但数据还是 B 时期的，比如超时用的 `s_t0` 没有随状态重置。

---

## 二、多定时器分时调度

一个硬件定时器打节拍，各任务在节拍里轮流执行。**没有抢占，执行顺序由你定**。

### 2.1 设计步骤

1. **定节拍**：取所有任务周期公约数中**实际能实现**的最大值。太小 → 中断频繁、开销大；太大 → 周期量化误差大。
2. **确认周期能被节拍整除**：不能整除就会被量化（如 2.5ms 周期在 1ms 节拍下变成 3ms）。用 `sched_analyze` 看 `errorPercent`，能接受就用，不能接受就换节拍。
3. **错开相位**：把周期相同的任务放到不同节拍上，避免全部堆在第 0 拍。
4. **算最坏一拍**：`sched_analyze` 的 `peakFitsInTick` 必须是 true。**这是生死线** —— 跑不完就会顺延，产生节拍漂移与抖动累积。
5. **留余量**：总占用率压到 70% 以下，给中断、故障路径和日后加功能留空间。

### 2.2 相位错开的写法

```c
/* 同一个 10ms 周期，用不同的 tick 偏移量把它们分散开 */
#define PERIOD_TICKS 10
const uint8_t OFFSET_A = 0, OFFSET_B = 3, OFFSET_C = 7;

void tick_isr(void)              /* 每 1ms 进一次，只做最轻的事 */
{
    static uint8_t t = 0;
    s_tick++;
    t = (uint8_t)((t + 1u) % PERIOD_TICKS);
    if (t == OFFSET_A) s_flags |= FLAG_A;
    if (t == OFFSET_B) s_flags |= FLAG_B;
    if (t == OFFSET_C) s_flags |= FLAG_C;
}

void main_loop(void)
{
    for (;;) {
        if (s_flags & FLAG_A) { s_flags &= ~FLAG_A; task_a(); }   /* 先取标志再清，避免覆盖 */
        if (s_flags & FLAG_B) { s_flags &= ~FLAG_B; task_b(); }
        if (s_flags & FLAG_C) { s_flags &= ~FLAG_C; task_c(); }
    }
}
```

要点：
- **ISR 只置标志**，任务体在主循环里执行 —— 执行时间不进中断，就不会拖垮中断响应。
- `s_flags` 是主循环与 ISR 共享的：必须 `volatile`；**读-改-写要防竞态**（上面的 `&= ~` 是非原子读改写，若 ISR 同时置别的位会丢。多标志位场景应改用「主循环只在关中断下清位」或每任务一个独立标志变量）。
- 若任务本身耗时接近节拍，说明结构选错了，该上 RTOS 或拆任务。

### 2.3 "重活"的处理

节拍调度只适合**短任务**。遇到长活儿（Flash 擦写、大块计算、等待外部芯片就绪）：
- **拆成分段状态机**，每拍做一小段，维护一个"进度"变量，不要在一拍里做完。
- 或把它挪到独立的低优先级后台，用状态机推进。

---

## 三、定时器 + 中断调度

各任务直接挂在自己的中断里，由硬件定时器分别触发。

### 3.1 铁律

- **ISR 只做最小必要工作**：清标志、读数据、置标志位/写环形缓冲，然后退出。
- **ISR 内绝不忙等、绝不长延时、绝不调阻塞函数**（`malloc`、`printf`、带锁接口、总线事务）。
- **共享变量加 `volatile`**；多字节量在主线读时要防撕裂（关中断或用单次原子读）。
- **优先级要成体系**：优先级高的 ISR 会抢占低的，耗时长的中断不要给高优先级。ARM Cortex-M0 **没有优先级分组配置**，可用优先级位更少，给 M3 写的配置代码拿过去可能无效。
- **中断里的除法与浮点要评估**：无硬件除法器的内核上，一次整数除法可能几十周期。

### 3.2 生产者的标准形态（环形缓冲）

```c
#define RX_RING 64u                    /* 2 的幂 */
#define RX_MASK (RX_RING - 1u)
static volatile uint8_t  s_rx[RX_RING];
static volatile uint16_t s_head;       /* 只由 ISR 改 */
static volatile uint16_t s_tail;       /* 只由主循环改 */
static volatile uint32_t s_overrun;

void UART_IRQHandler(void)             /* ISR：绝不阻塞、绝不丢帧而不计数 */
{
    uint16_t next;
    uint8_t  data = UART_READ();       /* 取字节并清标志 */
    next = (uint16_t)((s_head + 1u) & RX_MASK);
    if (next == s_tail) { s_overrun++; return; }   /* 满：丢弃并计数，绝不等 */
    s_rx[s_head] = data;
    s_head = next;
}

int rx_pop(uint8_t *out)               /* 主循环：非阻塞取字节 */
{
    if (s_head == s_tail) return 0;
    *out = s_rx[s_tail];
    s_tail = (uint16_t)((s_tail + 1u) & RX_MASK);
    return 1;
}
```

**单生产者 / 单消费者 + 环形缓冲**是免锁的：每个指针只有一个写者，因此不需要临界区。**超限要计数**，否则"偶发丢帧"永远查不出来。

### 3.3 时间基准

- **不要用软件循环做延时**（`for(i=0;i<100000;i++);`）—— 会被优化掉、随主频变化、且阻塞一切。用硬件定时器。
- **计时用无符号减法**，让溢出自然回绕：

  ```c
  static inline bool elapsed(uint32_t now, uint32_t since, uint32_t limit)
  { return (uint32_t)(now - since) >= limit; }   /* 无符号回绕安全，不要写 now > since + limit */
  ```
- **tick 频率与位数要一起设计**：16 位 tick 在 1kHz 下每 65.5s 溢出一次；32 位在 1MHz 下约 71 分钟溢出。回绕本身不是问题（上面的写法安全），但**别用绝对时间做比较**。

---

## 四、从裸机迁到 RTOS 的判据

出现以下任一条，就该考虑 RTOS，而不是继续往裸机里堆：
- 需要一个任务**阻塞等待**某个事件（而不是靠状态机轮询）；
- 任务间有明确优先级，且高优先级任务必须能抢占；
- 任务数量超过 ~5 个，或主循环里出现了"先算 XX 再算 YY"的时序耦合；
- 有多个阻塞式外设操作（等总线、等网络）需要并行推进。

反之，**任务只有 2~3 个、逻辑清晰、RAM 只有几 KB 时，裸机 + 状态机比 RTOS 更可靠** —— 少一个调度器就少一类竞态。这是常见误判：把"想用 RTOS"当成"需要 RTOS"。

---

## 五、审查调度代码时的检查项

1. 状态是否**显式且集中**？有没有 `bool` 拼出的隐式状态？
2. 每个等待型状态有没有**超时出口**？
3. ISR 是否只做最小工作？有没有忙等、阻塞、`printf`？
4. 跨 ISR 的共享变量有没有 `volatile`？多字节量与读改写有没有防竞态？
5. 节拍调度的**最重一拍**是否跑得完？周期是否被量化为非预期值？
6. 所有延时是硬件定时器还是软件循环？计时是否用了无符号回绕安全的写法？
7. 缓冲满/超时/错误路径是否**有计数与状态上报**（否则现场故障不可定位）？
8. 该不该上 RTOS？还是当前的裸机结构只是没写清楚？
