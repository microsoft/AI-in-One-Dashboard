import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DataProvider } from '../data/DataProvider'
import ReportDemo from './ReportDemo'

createRoot(document.getElementById('root')!).render(<StrictMode><DataProvider><ReportDemo /></DataProvider></StrictMode>)
