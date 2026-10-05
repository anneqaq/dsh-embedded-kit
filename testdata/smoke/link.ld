/*
 * 最小链接脚本 —— 只为验证体积分析。
 *
 * 关键在于提供一个真实的 `MEMORY` 块：GNU ld 的 map 会把它打印成
 * `Memory Configuration`，而 fw_size 正是靠这块信息判断哪个区域是 Flash（不可写）、
 * 哪个是 RAM（可写），进而把 `.data` 正确地**同时**计入 ROM 与 RAM。
 *
 * 没有 MEMORY 块的默认脚本会让 ROM/RAM 判定失效 —— 这是设计上的取舍：
 * 宁可报"无法判定"，也不靠段名去猜。
 */

ENTRY(Reset_Handler)

MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 16K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 4K
}

SECTIONS
{
  .isr_vector :
  {
    KEEP(*(.isr_vector))
  } > FLASH

  .text :
  {
    *(.text*)
    *(.init*)
    *(.fini*)
    /* Xtensa 的常量池必须与使用它的代码同段，否则链接器报
       "dangerous relocation: l32r: literal placed after use"。
       ARM / RISC-V 上这两个段为空，加进来无副作用。 */
    *(.literal*)
    *(.srodata*)
  } > FLASH

  .rodata :
  {
    *(.rodata*)
  } > FLASH

  /* 初值在 FLASH（LMA），运行时在 RAM（VMA）—— 体积分析的经典考点。 */
  .data :
  {
    *(.data*)
  } > RAM AT > FLASH

  .bss :
  {
    *(.bss*)
    *(COMMON)
  } > RAM

  /* 预留的堆栈区：只在 RAM 里占位，不产生文件贡献。 */
  ._user_heap_stack :
  {
    . = . + 0x200;
  } > RAM
}
