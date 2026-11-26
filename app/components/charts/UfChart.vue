<script setup lang="ts">
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart, BarChart, HeatmapChart, CustomChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent, MarkAreaComponent, VisualMapComponent, LegendComponent } from 'echarts/components'
import VChart from 'vue-echarts'
import type { EChartsOption } from 'echarts'

use([CanvasRenderer, LineChart, BarChart, HeatmapChart, CustomChart, GridComponent, TooltipComponent, DataZoomComponent, MarkLineComponent, MarkAreaComponent, VisualMapComponent, LegendComponent])

/**
 * ECharts wrapper that inherits the Unifire tokens (fonts, grid lines, tooltip surface) in both themes.
 * Pass a partial option; base styling is merged in.
 */
const props = withDefaults(defineProps<{ option: EChartsOption, height?: string }>(), { height: '260px' })
const colorMode = useColorMode()

const css = (name: string) => (import.meta.client ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : '')
const base = computed<EChartsOption>(() => {
  void colorMode.value // re-evaluate on theme change
  const text = css('--ui-text-muted') || '#888'
  const border = css('--ui-border-muted') || '#ddd'
  const surface = css('--uf-surface') || '#fff'
  return {
    textStyle: { fontFamily: 'Inter, "PingFang TC", "Noto Sans TC", sans-serif', color: text },
    grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: surface,
      borderColor: border,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: css('--ui-text-highlighted') || '#111', fontSize: 12 },
      extraCssText: 'box-shadow: var(--uf-shadow-lg); border-radius: 8px;',
      axisPointer: { type: 'line', lineStyle: { color: border, width: 1 } },
    },
    xAxis: { axisLine: { lineStyle: { color: border } }, axisTick: { show: false }, axisLabel: { color: text, fontSize: 11 }, splitLine: { show: false } },
    yAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: text, fontSize: 11 }, splitLine: { lineStyle: { color: border, type: 'dashed' } } },
  }
})

function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const av = out[k]
    out[k] = av && v && typeof av === 'object' && typeof v === 'object' && !Array.isArray(av) && !Array.isArray(v)
      ? merge(av as Record<string, unknown>, v as Record<string, unknown>)
      : v
  }
  return out
}
const merged = computed(() => merge(base.value as Record<string, unknown>, props.option as Record<string, unknown>) as EChartsOption)
</script>

<template>
  <VChart :option="merged" :style="{ height }" autoresize class="w-full" />
</template>
