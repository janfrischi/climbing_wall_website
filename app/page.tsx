import SensorDashboard from "@/components/sensor-dashboard"

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col">
      <header className="bg-slate-800 text-white p-4 shadow-md">
        <h1 className="text-2xl font-bold text-center">ADC Sensor Data Platform</h1>
      </header>
      <div className="flex-1 container mx-auto p-4">
        <SensorDashboard />
      </div>
    </main>
  )
}
