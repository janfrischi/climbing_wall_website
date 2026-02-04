import SensorDashboard from "./components/sensor-dashboard"
import { Mountain } from "lucide-react"

function App() {
  return (
    <main className="min-h-screen flex flex-col">
      <header className="bg-slate-800 text-white p-4 shadow-md">
        <div className="container mx-auto flex items-center justify-center">
          <Mountain className="h-6 w-6 mr-2" />
          <h1 className="text-2xl font-bold">THE CLIMBING WALL</h1>
        </div>
      </header>
      <div className="flex-1 container mx-auto p-4">
        <SensorDashboard />
      </div>
    </main>
  )
}

export default App
