/*
 * 体积分析验证用的最小固件。
 *
 * 刻意让每一类节区都有内容，以便验证 ELF 与 GNU ld map 的分类是否正确：
 *   .isr_vector → FLASH 中的只读数据（向量表）
 *   .text       → 代码
 *   .rodata     → 只读常量表
 *   .data       → 初值在 FLASH、运行时在 RAM
 *   .bss        → 只占 RAM
 *
 * 不依赖任何厂商头文件，因此可以被 ARM / RISC-V / Xtensa 等多个工具链编译，
 * 用来证明"架构无关"。
 */

#include <stdint.h>

/* 向量表：模拟真实 MCU 的 .isr_vector，位于 FLASH 且只读。 */
__attribute__((section(".isr_vector"), used))
const uint32_t g_vectors[8] = {
	0x20001000u, /* 初始栈顶 */
	0x08000009u, /* 复位入口（Thumb 置位） */
	0u, 0u, 0u, 0u, 0u, 0u,
};

/* .data：有初值，初值必须存进 FLASH，运行时占用 RAM。 */
volatile uint32_t g_counter = 0x12345678u;

/* .bss：零初始化，只占 RAM，不占 FLASH。 */
volatile uint8_t g_rx_buf[64];
volatile uint32_t g_overruns;

/* .rodata：只读常量表。 */
const uint16_t g_crc_table[16] = {
	0x0000u, 0x1021u, 0x2042u, 0x3063u, 0x4084u, 0x50a5u, 0x60c6u, 0x70e7u,
	0x8108u, 0x9129u, 0xa14au, 0xb16bu, 0xc18cu, 0xd1adu, 0xe1ceu, 0xf1efu,
};

/* 复位入口：同时用到 .text、.bss 与 .data，确保三者都真实存在。 */
void Reset_Handler(void)
{
	uint32_t sum = 0u;
	for (uint32_t i = 0u; i < 64u; i++) {
		g_rx_buf[i] = (uint8_t)(i & 0xffu);
		sum += g_rx_buf[i];
	}
	g_counter = sum;
	g_overruns++;
	for (;;) {
		/* 停在复位处理里，无需运行 */
	}
}
