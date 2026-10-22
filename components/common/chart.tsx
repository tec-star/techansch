'use client'
import { useEffect, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import cn from 'classnames'
import { deepOverride } from '../../utils/chart'
// import { useSelector } from 'react-redux'
// import { toast } from 'react-toastify'

interface Props {
   title?: string
   labels?: string[]
   legend?: string[]
   data: Array<{
      name: string
      data: any[]
      dataType?: string
      type?: string
      inverse?: string
      stack?: string
      yAxis?: string
      itemStyle?: any
      incomplete?: boolean
      term?: { type: string; value: string }
   }>
   option?: any
   className?: string
   loading?: boolean
}

const colors = [
   '#000000',
   '#ea5545',
   '#f46a9b',
   '#ef9b20',
   '#edbf33',
   '#ede15b',
   '#bdcf32',
   '#87bc45',
   '#27aeef',
   '#b33dc6',
   '#e60049',
   '#0bb4ff',
   '#50e991',
   '#e6d800',
   '#9b19f5',
   '#ffa300',
   '#dc0ab4',
   '#b3d4ff',
   '#00bfa0',
]

function createPattern(color: string) {
   const canvas = document.createElement('canvas')
   canvas.width = 10
   canvas.height = 10
   const ctx = canvas.getContext('2d')

   // Draw diagonal stripes
   if (ctx) {
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(0, 10)
      ctx.lineTo(10, 0)
      ctx.stroke()

      // Top-left corner mark
      ctx.beginPath()
      ctx.arc(0, 0, 1.5, 0, Math.PI * 2)
      ctx.fill()

      // Bottom-right corner mark
      ctx.beginPath()
      ctx.arc(10, 10, 1.5, 0, Math.PI * 2)
      ctx.fill()
   }

   return canvas
}

function Chart({
   title,
   labels,
   legend,
   data,
   loading,
   option,
   className,
}: Props) {
   const [options, setOptions] = useState<any>(null)
   const [chartLoading, setChartLoading] = useState<boolean>(false)
   const [errMessage, setErrMessage] = useState<string>('')

   useEffect(() => {
      if (!data?.length) {
         setOptions({
            title: {
               text: title || '',
               textAlign: 'left',
               top: 15,
            },
         })
         return
      }

      const yAxisColors = data[0].type === 'candlestick' ? ['black', ...colors] : colors

      const yAxis: any[] = [],
         stacks: string[] = []
      let emptyData: string[] = []
      for (let i = 0; i < data.length; i++) {
         if (!data[i].data || data[i].data.length == 0) {
            emptyData.push(data[i].name)
         }
         // series with the same yAxis name share one axis
         const sameAxis = !!data[i].yAxis && yAxis.some((item: any) => item.name === data[i].yAxis)
         if (!sameAxis && (!data[i].stack || !stacks.includes(data[i].stack!))) {
            yAxis.push({
               name: data[i].yAxis || data[i].stack || data[i].name,
               inverse: data[i].inverse,
            })
            if (data[i].stack) stacks.push(data[i].stack!)
         }
      }

      const dataSeries = data.map((item: any, index: number) => {
         return {
            ...item,
            type: item?.type || 'line',
            yAxisIndex: yAxis
               .map((item: any) => item.name)
               .indexOf(item?.yAxis || item?.stack || item.name),

            smooth: 0.1,

            symbol: item?.symbol || 'emptycircle',
            symbolSize: item?.symbolSize || 3,
            lineStyle: {
               ...item.lineStyle,
               type: item.lineStyle?.type || (item.incomplete ? 'dashed' : 'solid'),
            },
            emphasis: {
               focus: 'series',
            },
            itemStyle:
               item?.type === 'bar' && item.incomplete
                  ? {
                       ...item.itemStyle,
                       color: function (params: any) {
                          if (params.dataIndex === item.data.length - 1) {
                             // Last bar
                             return {
                                image: createPattern(yAxisColors[index]),
                                repeat: 'repeat',
                             }
                          }
                          return yAxisColors[index] // Regular color for other bars
                       },
                    }
                  : {},
         }
      }) 

      if (emptyData.length > 0) {
         setErrMessage(
            `Not enough data in the selected time period for the following items: ${emptyData.join(
               ', ',
            )}`,
         )
      } else {
         setErrMessage('')
      }

      const initialOption: any = {
         title: {
            text: title || '',
            textAlign: 'left',
            // left: 60,
            top: 15,
         },

         color: colors,
         tooltip: {
            trigger: 'axis',
            axisPointer: {
               type: 'cross',
            },
            extraCssText: 'max-width: 300px; white-space: normal;', // Limit tooltip width and allow wrapping
            formatter: function (params: any) {
               let tooltipContent = params[0].axisValueLabel + '<br/>'
               params.forEach(function (item: any) {
                  let value = parseFloat(item.value[1]).toLocaleString('en-US', {
                     minimumFractionDigits: 2,
                     maximumFractionDigits: 2,
                  })
                  tooltipContent +=
                     item.marker +
                     ' ' +
                     item.seriesName +
                     ': <strong>' +
                     value +
                     '</strong><br/>'
               })

               // Get the date from params[0].axisValueLabel
               const date = params[0].axisValueLabel

               // Get the terms for this date

               return tooltipContent
            },
         },
         dataZoom: [{
            type: 'inside'
         }],
         grid: {
            left: yAxis.length === 1 ? 65 : 40,
            right: (yAxis.length - 1) * 40 + 10,
         },
         toolbox: {
            feature: {
               dataView: { show: false, readOnly: false },
               restore: { show: true },
               saveAsImage: { show: false },
            },
         },
         legend: {
            data: legend || data.map((item: any) => item.name),
            show: true,
            orient: 'horizontal',
            left: 'center',
            bottom: 5,
         },
         xAxis: [
            {
               type: labels?.length ? 'category' : 'time',
               axisTick: {
                  alignWithLabel: true,
               },
               // prettier-ignore
               data: labels,
            },
         ],
         yAxis: yAxis.map((item: any, index: number) => ({
            type: 'value',
            name: item.name,
            inverse: item.inverse || false,
            nameRotate: 90,
            nameLocation: 'center',
            nameTextStyle: {
               verticalAlign: 'top',
               align: 'center',
               padding: [index ? 0 : yAxis.length === 1 ? -36 : -15, 0, 0, 0],
            },
            position: !index ? 'left' : 'right',
            offset: index === yAxis.length - 1 ? 10 : index * 40 + 10,
            alignTicks: true,
            axisLine: {
               show: true,
               lineStyle: {
                  color: yAxisColors[index],
               },
            },
            axisLabel: {
               formatter: (value: number) => {
                  const scaled =
                     value >= 1000000
                        ? `${value / 1000000}M`
                        : value >= 1000
                        ? `${value / 1000}K`
                        : value
                  return `${scaled}${item.unit || ''}`
               },
               rotate: yAxis?.length === 1 ? 0 : 90,
               padding: [-5, 0, -5, 0],
            },
            scale: true,
            hideOverlap: true,
         })),
         series: dataSeries,
      }
      setOptions(deepOverride(initialOption, option || {}))
   }, [data])

   return (
      options 
         ? <ReactECharts
               option={options}
               className={`h-full w-full ${chartLoading ? 'opacity-30' : ''}`}
               style={{ height: '100%', width: '100%' }}
               notMerge={true}
               lazyUpdate={true}
               showLoading={loading}
            />
         : <></>
   )
}

export default Chart
