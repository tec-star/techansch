import cn from 'classnames'

interface Props {
    selectMenu: (menu: string) => void,
    menu: string
}

function Header(props: Props) {
    const { selectMenu, menu } = props

    return (
        <div className="fixed top-0 left-0 w-full flex justify-between items-center px-3 py-1 bg-black border-b border-white">
            <p className="italic text-lg text-white">Analysis</p>
            <div className="flex gap-1">
                {
                    [
                        // 'auth', 
                        // // 'lons', 
                        // 'sims', 
                        // 'simt',
                        // // 'exps', 
                        // // 'sime', 
                        // 'ansy'
                    ].map((item: string) => (
                        <button 
                            key={item} 
                            onClick={() => selectMenu(item)}
                            className={cn(
                                "border border-gray-600 px-2 text-white text-xs uppercase", 
                                { 'bg-blue-600 bg-opacity-40': menu === item }
                            )}
                        >
                            {item}
                        </button>
                    ))
                }
            </div>
        </div>
    )
}

export default Header