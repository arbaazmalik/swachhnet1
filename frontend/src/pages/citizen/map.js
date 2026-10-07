'use client'
import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { mapAPI } from '../../utils/api'
import CitizenLayout from '../../components/shared/CitizenLayout'
import { SectionCard } from '../../components/ui'
import toast from 'react-hot-toast'
import { RECYCLING_CENTERS } from '../../utils/centersData'
import { calculateDistance, formatDistance } from '../../utils/geoUtils'

// Dynamic import for Leaflet map component (SSR: false)
const LeafletMap = dynamic(() => import('../../components/shared/LeafletMap'), {
  ssr: false,
  loading: () => <div className="w-full h-full flex items-center justify-center bg-slate-50 text-slate-400">Loading map...</div>
})

const FILTERS = [
  { value: '',          label: 'All Centers',   emoji: '🏢' },
  { value: 'recycling', label: 'Recycling',      emoji: '♻️' },
  { value: 'scrap',     label: 'Scrap Dealers',  emoji: '🔧' },
  { value: 'ewaste',    label: 'E-Waste',         emoji: '💻' },
  { value: 'organic',   label: 'Compost/Organic', emoji: '🌱' },
]

export default function MapPage() {
  const [filter,    setFilter]    = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [centers,   setCenters]   = useState([])
  const [loading,   setLoading]   = useState(false)
  const [userLoc,   setUserLoc]   = useState(null)
  const [hoveredId, setHoveredId] = useState(null)

  useEffect(() => {
    // Attempt to get user location, default to Dhampur if denied
    navigator.geolocation.getCurrentPosition(
      pos => setUserLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      ()  => {
        console.log('Location denied, using Dhampur default')
        setUserLoc({ lat: 29.2882, lng: 78.5031 })
      }
    )
  }, [])

  useEffect(() => { 
    if (userLoc) fetchCenters(userLoc.lat, userLoc.lng, filter) 
  }, [userLoc, filter])

  const [isLive, setIsLive] = useState(true)

  const fetchCenters = async (lat, lng, type) => {
    setLoading(true)
    try {
      // radius 5km
      const response = await mapAPI.centers(lat, lng, 5000, type)
      const data = response?.data || response
      const apiCenters = data?.centers || []
      setIsLive(data?.isLive ?? true)
      setCenters(apiCenters)
    } catch (err) { 
      console.warn('Map API Error:', err)
      setIsLive(false)
      setCenters([])
    } finally { 
      setLoading(false) 
    }
  }

  // Derived filtered & sorted list
  const displayCenters = centers
    .filter(c => !filter || c.type === filter)
    .filter(c => !searchQuery || 
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      c.address.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .map(c => ({
      ...c,
      distance: userLoc ? calculateDistance(userLoc.lat, userLoc.lng, c.lat, c.lng) : null
    }))
    .sort((a, b) => (a.distance || 0) - (b.distance || 0))

  return (
    <div className="pb-10">
      <div className="page-header">
        <div>
          <h1 className="page-title text-3xl font-bold text-slate-800">Map & Recycling Centers</h1>
          <p className="page-sub text-slate-500 mt-1">Find nearby recycling centers, scrap dealers, and drop-off points</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
        {/* Map Section */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
            {/* Filter pills */}
            <div className="flex gap-2 flex-wrap">
              {FILTERS.map(f => (
                <button 
                  key={f.value} 
                  onClick={() => setFilter(f.value)}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 border
                    ${filter === f.value 
                      ? 'bg-green-600 text-white border-green-600 shadow-md shadow-green-100' 
                      : 'bg-white text-slate-600 border-slate-200 hover:border-green-400 hover:bg-green-50'}`}
                >
                  {f.emoji} {f.label}
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="relative w-full md:w-64">
              <input 
                type="text" 
                placeholder="Search by name or area..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-4 py-2 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition-all"
              />
              <span className="absolute right-3 top-2.5 text-slate-400">🔍</span>
            </div>
          </div>

          <div className="card overflow-hidden shadow-xl border-none ring-1 ring-slate-100 rounded-2xl">
            <div className="w-full h-[520px]">
              {userLoc ? (
                <LeafletMap 
                  center={[userLoc.lat, userLoc.lng]} 
                  zoom={14} 
                  markers={displayCenters} 
                  userLoc={userLoc}
                  hoveredId={hoveredId}
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center bg-slate-50 text-slate-400 space-y-3">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600"></div>
                  <p className="text-sm font-medium">Initializing Map...</p>
                </div>
              )}
            </div>
          </div>
          {loading && (
            <div className="flex items-center justify-center gap-2 mt-2">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-bounce"></div>
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-bounce delay-75"></div>
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-bounce delay-150"></div>
              <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Updating Results</span>
            </div>
          )}
        </div>

        {/* Centers list */}
        <div className="flex flex-col h-full">
          <SectionCard 
            title={`Nearby Results (${displayCenters.length})`}
            className="h-full flex flex-col shadow-lg border-none rounded-2xl overflow-hidden"
          >
            <div className="divide-y divide-slate-100 overflow-y-auto custom-scrollbar" style={{ maxHeight: '600px' }}>
              {displayCenters.length === 0 ? (
                <div className="p-10 text-center space-y-3">
                  <div className="text-4xl">🏜️</div>
                  <h3 className="text-slate-800 font-semibold">No centers found</h3>
                  <p className="text-sm text-slate-400">Try adjusting your filters or search query.</p>
                  <button 
                    onClick={() => {setFilter(''); setSearchQuery('')}}
                    className="text-xs font-bold text-green-600 hover:underline"
                  >
                    Reset all filters
                  </button>
                </div>
              ) : displayCenters.map(c => (
                <div 
                  key={c.id} 
                  onMouseEnter={() => setHoveredId(c.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  className={`group flex items-start gap-4 px-5 py-4 transition-all cursor-pointer border-l-4
                    ${hoveredId === c.id ? 'bg-green-50 border-green-500' : 'hover:bg-slate-50 border-transparent'}`}
                >
                  <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-xl flex-shrink-0 transition-transform group-hover:scale-110 shadow-sm
                    ${c.type === 'recycling' ? 'bg-green-100 text-green-600' : 
                      c.type === 'ewaste' ? 'bg-blue-100 text-blue-600' :
                      c.type === 'organic' ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-600'}`}>
                    {c.type === 'recycling' ? '♻️' : c.type === 'ewaste' ? '💻' : c.type === 'organic' ? '🌱' : '🔧'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-bold text-slate-800 truncate">{c.name}</h3>
                      <span className="text-[10px] font-black text-slate-300 uppercase tracking-tighter whitespace-nowrap">
                        {c.type}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 truncate mt-0.5 flex items-center gap-1">
                      <span className="opacity-50">📍</span> {c.address}
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                      {c.distance !== null && (
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded-md font-bold">
                            {formatDistance(c.distance)}
                          </span>
                        </div>
                      )}
                      {c.rating && (
                        <div className="flex items-center gap-0.5 text-xs text-amber-500 font-bold">
                          <span>★</span> {c.rating}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        </div>
      </div>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #e2e8f0;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #cbd5e1;
        }
      `}</style>
    </div>
  )
}

MapPage.getLayout = page => <CitizenLayout>{page}</CitizenLayout>

