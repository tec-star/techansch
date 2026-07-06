'use client'
import moment from 'moment'
import { useEffect, useState } from 'react'
import Chart from '../common/chart'
import { allInOne } from '../../helpers/ver3'

interface Props {

}

function HomeChart () {
    const [data, setData] = useState<any>(null)

    useEffect(() => {
        const updateData = async () => {

            const { total, count, drawdown, orders } = await allInOne()

            const series: any[] = []

            series.push({
                name: 'Chart',
                data: orders.map((item: any) => [moment.unix(item.exitTime).toDate(), item.total]),
                type: 'line',
                yAxis: 'value'
            })

            setData(series)
        }

        updateData()
    }, [])

    return (
        data 
            ? <div className='w-full h-[600px]'>
                <Chart 
                    data={data}
                    className='h-full'
                />
            </div>
            : <></>
    )
}

export default HomeChart