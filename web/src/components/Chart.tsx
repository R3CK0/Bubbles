import { useEffect, useRef } from "react";
import * as echarts from "echarts";

export type EChartsOption = echarts.EChartsOption;

/**
 * Thin ECharts wrapper. setOption without notMerge so state changes MORPH
 * existing series instead of redrawing (the app's chart grammar).
 */
export function Chart({
  option,
  height,
  onClick,
  onHover,
}: {
  option: EChartsOption;
  height: number;
  onClick?: (params: echarts.ECElementEvent) => void;
  onHover?: (params: echarts.ECElementEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);
  const hoverRef = useRef(onHover);
  clickRef.current = onClick;
  hoverRef.current = onHover;

  useEffect(() => {
    const el = ref.current!;
    const c = echarts.init(el);
    chart.current = c;
    c.on("click", (p) => clickRef.current?.(p));
    c.on("mouseover", (p) => hoverRef.current?.(p));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(
      {
        animationDuration: 700,
        animationDurationUpdate: 600,
        animationEasing: "cubicOut",
        ...option,
      } as EChartsOption,
      { replaceMerge: ["series", "xAxis", "yAxis"] },
    );
  }, [option]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}

/** Shared axis/tooltip cosmetics that track the theme tokens. */
export function chartBase(ink: string, muted: string, line: string) {
  return {
    textStyle: { fontFamily: "Inter, system-ui, sans-serif" },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "rgba(24,29,27,.96)",
      borderColor: line,
      textStyle: { color: "#E8ECEA", fontSize: 12 },
      valueFormatter: (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }) : String(v ?? "")),
    },
    grid: { left: 8, right: 12, top: 24, bottom: 4, containLabel: true },
    xAxis: { axisLine: { lineStyle: { color: line } }, axisLabel: { color: muted, fontSize: 11 }, axisTick: { show: false } },
    yAxis: { splitLine: { lineStyle: { color: line } }, axisLabel: { color: muted, fontSize: 11 } },
  };
}
