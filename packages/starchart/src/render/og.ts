import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Graph } from "../core/graph.js";
import { renderTemplate } from "./template.js";

/**
 * OG / social image renderer: an SVG template filled with facts, written as SVG or rasterized to
 * PNG with resvg (loaded lazily so commands that never render images skip the native module).
 */

/** The SVG's intrinsic width from its `width` attribute or viewBox. */
export function svgWidth(svg: string): number | undefined {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return undefined;
  const width = /\swidth\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i.exec(root)?.[1];
  if (width) return Math.round(Number(width));
  const viewBox = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+[\d.]+\s*["']/i.exec(root)?.[1];
  return viewBox ? Math.round(Number(viewBox)) : undefined;
}

export async function rasterizeSvg(svg: string): Promise<Buffer> {
  const { Resvg } = await import("@resvg/resvg-js");
  const width = svgWidth(svg);
  const resvg = new Resvg(svg, {
    fitTo: width ? { mode: "width", value: width } : { mode: "original" },
    font: { loadSystemFonts: true },
  });
  return Buffer.from(resvg.render().asPng());
}

/** Renders the template to bytes: SVG text, or PNG when `format` is "png". */
export async function renderOgBuffer(templatePath: string, graph: Graph, format: "svg" | "png"): Promise<Buffer> {
  const source = await readFile(templatePath, "utf8");
  const svg = renderTemplate(source, graph, {}, { escape: "xml", name: basename(templatePath) });
  return format === "png" ? rasterizeSvg(svg) : Buffer.from(svg, "utf8");
}

export async function renderOg(templatePath: string, graph: Graph, outPath: string): Promise<{ bytes: number }> {
  const bytes = await renderOgBuffer(templatePath, graph, /\.png$/i.test(outPath) ? "png" : "svg");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, bytes);
  return { bytes: bytes.length };
}
