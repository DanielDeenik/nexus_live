/*
 * Zoomable sunburst, ported from DTrack's SunburstZoomChart.
 *
 * Based on:
 *   https://observablehq.com/@d3/sunburst/2
 *   https://observablehq.com/@d3/zoomable-sunburst
 *   https://dev.to/andrewchmr/react-d3-sunburst-chart-3cpd
 *
 * Copyright 2018-2020 Observable, Inc.
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * Full notice in ./LICENSE. Changes for Nexus: typed, no MUI, sized to its
 * container and redrawn on resize, dark theme colours, inline tooltip.
 */
import * as d3 from 'd3'
import { Download } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { hrs } from '../../../lib/nexus'

export interface TreeNode {
  name: string
  value?: number
  children?: TreeNode[]
}

interface Arc { x0: number; x1: number; y0: number; y1: number }
type Node = d3.HierarchyRectangularNode<TreeNode> & { current: Arc; target?: Arc }

interface Hover { names: string[]; value: number; parentValue: number; x: number; y: number }

const round1 = (n: number) => hrs(n)

export function SunburstZoomChart({ data, onDownload }: { data: TreeNode; onDownload?: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const [width, setWidth] = useState(0)

  // Redraw when the container changes size (phone rotation, sidebar toggle).
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)))
    ro.observe(el)
    setWidth(Math.floor(el.clientWidth))
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = boxRef.current
    if (!el || width <= 0) return
    const radius = width / 6
    // Labels run along one ring, so the ring depth sets how many characters fit.
    const maxChars = Math.max(6, Math.floor(radius / 5.5))
    const arc = d3.arc<Arc>()
      .startAngle((d) => d.x0)
      .endAngle((d) => d.x1)
      .padAngle((d) => Math.min((d.x1 - d.x0) / 2, 0.005))
      .padRadius(radius * 1.5)
      .innerRadius((d) => d.y0 * radius)
      .outerRadius((d) => Math.max(d.y0 * radius, d.y1 * radius - 1))
    const arcVisible = (d: Arc) => d.y1 <= 3 && d.y0 >= 1 && d.x1 > d.x0
    const labelVisible = (d: Arc) => d.y1 <= 3 && d.y0 >= 1 && (d.y1 - d.y0) * (d.x1 - d.x0) > 0.03
    const labelTransform = (d: Arc) => {
      const x = (((d.x0 + d.x1) / 2) * 180) / Math.PI
      const y = ((d.y0 + d.y1) / 2) * radius
      return `rotate(${x - 90}) translate(${y},0) rotate(${x < 180 ? 0 : 180})`
    }

    const hierarchy = d3.hierarchy(data).sum((d) => d.value ?? 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    const root = d3.partition<TreeNode>().size([2 * Math.PI, hierarchy.height + 1])(hierarchy) as Node
    root.each((d) => { (d as Node).current = d })
    const color = d3.scaleOrdinal<string, string>(d3.quantize(d3.interpolateRainbow, (data.children?.length ?? 0) + 1))

    d3.select(el).selectAll('svg').remove()
    const svg = d3.select(el).append('svg')
      .attr('viewBox', [0, 0, width, width].join(' '))
      .attr('width', width)
      .attr('height', width)
      .style('font-size', '10px')
      .style('display', 'block')
    const g = svg.append('g').attr('transform', `translate(${width / 2},${width / 2})`)
    const nodes = root.descendants().slice(1) as Node[]

    const path = g.append('g').selectAll<SVGPathElement, Node>('path').data(nodes).join('path')
      .attr('fill', (d) => { let n: Node = d; while (n.depth > 1) n = n.parent as Node; return color(n.data.name) })
      .attr('fill-opacity', (d) => (arcVisible(d.current) ? (d.children ? 0.85 : 0.6) : 0))
      .attr('pointer-events', (d) => (arcVisible(d.current) ? 'auto' : 'none'))
      .attr('d', (d) => arc(d.current))
    path.filter((d) => Boolean(d.children)).style('cursor', 'pointer').on('click', clicked)

    const total = g.append('text')
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
      .attr('fill', '#f1f5f9').style('font-size', '14px').style('font-weight', '600')
    const setTotal = (n: Node) => { if (n.children) total.text(`${round1(d3.sum(n.children, (c) => c.value ?? 0))} h`) }
    setTotal(root)

    path.on('mousemove', (event: MouseEvent, d) => {
      const box = el.getBoundingClientRect()
      setHover({
        names: d.ancestors().map((a) => a.data.name).reverse().slice(1),
        value: d.value ?? 0,
        parentValue: d.parent?.value ?? 0,
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      })
    }).on('mouseleave', () => setHover(null))

    const label = g.append('g').attr('pointer-events', 'none').attr('text-anchor', 'middle').style('user-select', 'none')
      .selectAll<SVGTextElement, Node>('text').data(nodes).join('text')
      .attr('dy', '0.35em')
      .attr('fill', '#f8fafc')
      .attr('fill-opacity', (d) => +labelVisible(d.current))
      .attr('transform', (d) => labelTransform(d.current))
      .text((d) => (d.data.name.length > maxChars ? `${d.data.name.slice(0, maxChars - 3)}...` : d.data.name))

    const parent = g.append('circle').datum(root).attr('r', radius).attr('fill', 'none').attr('pointer-events', 'all').on('click', clicked)

    function clicked(_event: unknown, p: Node) {
      parent.datum((p.parent as Node) || root)
      root.each((n) => {
        const d = n as Node
        d.target = {
          x0: Math.max(0, Math.min(1, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
          x1: Math.max(0, Math.min(1, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
          y0: Math.max(0, d.y0 - p.depth),
          y1: Math.max(0, d.y1 - p.depth),
        }
      })
      const t = d3.transition<d3.BaseType>().duration(750)
      // Move every arc, visible or not, so an interrupted zoom resumes cleanly.
      path.transition(t)
        .tween('data', (d) => { const i = d3.interpolate(d.current, d.target!); return (tt: number) => { d.current = i(tt) } })
        .filter(function (d) { return Boolean(+(this.getAttribute('fill-opacity') ?? 0)) || arcVisible(d.target!) })
        .attr('fill-opacity', (d) => (arcVisible(d.target!) ? (d.children ? 0.85 : 0.6) : 0))
        .attr('pointer-events', (d) => (arcVisible(d.target!) ? 'auto' : 'none'))
        .attrTween('d', (d) => () => arc(d.current) ?? '')
      label.filter(function (d) { return Boolean(+(this.getAttribute('fill-opacity') ?? 0)) || labelVisible(d.target!) })
        .transition(t)
        .attr('fill-opacity', (d) => +labelVisible(d.target!))
        .attrTween('transform', (d) => () => labelTransform(d.current))
      setTotal(p)
    }

    return () => { svg.interrupt(); svg.remove() }
  }, [data, width])

  return (
    <div className="relative w-full max-w-[560px] mx-auto">
      <div ref={boxRef} className="w-full aspect-square" aria-label="Hours by group, click a ring to zoom in, click the centre to zoom out" role="img" />
      {onDownload && (
        <button onClick={onDownload} className="absolute top-0 right-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700/50" title="Download CSV" aria-label="Download CSV">
          <Download size={18} />
        </button>
      )}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-slate-700 bg-slate-900/95 px-3 py-2 text-xs text-slate-200 shadow-lg"
          style={{ left: Math.min(hover.x + 12, width - 160), top: hover.y + 12, maxWidth: 200 }}
        >
          {hover.names.map((n, i) => <div key={i} className={i === hover.names.length - 1 ? 'font-semibold text-slate-50' : 'text-slate-400'}>{n}</div>)}
          <div className="mt-1 tabular-nums">{round1(hover.value)} h of {round1(hover.parentValue)} h</div>
          <div className="tabular-nums">{hover.parentValue > 0 ? ((hover.value / hover.parentValue) * 100).toFixed(1) : '0'}%</div>
        </div>
      )}
    </div>
  )
}
