---
name: storage-and-display
description: NVM/Flash 分区规划与擦除寿命、LVGL 显示缓冲与带宽。含磨损模型选错会把寿命算错几个数量级、LV_MEM_SIZE 无法静态计算必须实测这两个关键点。
whenToUse: 需要规划 Flash 分区、估 EEPROM 模拟的寿命、判断写入频率会不会磨坏 Flash、或算 LVGL 绘制缓冲占用与刷新带宽时。
---

# NVM 存储与 LVGL 显示缓冲

**本技能自带可执行脚本**，不要手算。

```bash
node {{PLUGIN_ROOT}}/skills/_shared/run-tool.mjs nvm_layout args.json
node {{PLUGIN_ROOT}}/skills/_shared/run-tool.mjs lvgl_mem hres=320 vres=240 color_depth_bits=16
```

`nvm_layout` 的分区表与写入负载是嵌套结构，**必须写 `.json` 文件再传路径**。零参数会让工具报缺参。

## 两个工具

| 工具名 | 算什么 |
|---|---|
| `nvm_layout` | 各分区地址范围、**重叠检测**、擦除页与写粒度**对齐检查**、剩余空间、按写入频率估算**擦除寿命（年）** |
| `lvgl_mem` | 整帧字节、绘制缓冲占用、满屏刷新的带宽与总线占用率；并检查几个高频配置错误 |

## nvm_layout：磨损模型选错，寿命能差几个数量级

两种模型必须按你的**实际写法**选，不能随便挑一个：

- `page-rewrite`：整页重写 —— 每次都擦同一页，寿命最短
- `circular-log`：环形日志 —— 擦除均摊到所有页（8 页环形日志 ≈ 8 倍耐久）

选错的后果是把寿命算错几千倍，而结果看起来同样"合理"。

- `erase_cycles_max` **查数据手册**（常见 1 万~10 万次）。**不给就不算寿命**，本实现不内置经验值
- 擦除单位与写入单位不同：`page_size` 是**擦除页大小**，`write_granule_bytes` 是最小写入粒度（有些器件只能按 4/8 字节写）。两者都要与分区边界对齐
- **重叠检测**是硬判定：分区重叠不会报错，只会让运行时行为诡异

## lvgl_mem：LV_MEM_SIZE 无法静态计算

工具能算的是**绘制缓冲占用**与**带宽**；`LV_MEM_SIZE`（LVGL 自己的堆）**必须用 `lv_mem_monitor()` 实测** —— 本实现只给明确标注的经验起点，不给"看起来合理"的数字。

会主动检查的几个高频配置错误：

- **局部缓冲行数过小** —— 会把一次重绘拆成很多次 flush，反而变慢（`partial_lines` 默认取屏高 1/10）
- **全屏缓冲吃掉过半 RAM**
- **双缓冲但驱动不支持流水**

带宽部分：给了 `refresh_rate_hz` 才折算，给了 `bus_bytes_per_second` 才算占用率 —— 没有总线带宽就只有一个孤立的字节数，说明不了问题。

## 输出怎么读

`checks` 每项形如 `{ name, pass, detail }`；`pending` 点名**因缺数据而未算的项**（不是 0，也不是通过）。
输出是设计值；实际擦写寿命、实际刷新帧率必须实测。
