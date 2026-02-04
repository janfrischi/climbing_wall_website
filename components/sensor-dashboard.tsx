"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Download, Pause, Play, Power, PowerOff } from "lucide-react"
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  type ChartOptions,
} from "chart.js"
import { Line } from "react-chartjs-2"

// Register Chart.js components
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend)

// Define the data structure for sensor readings
interface SensorReading {
  timestamp: number
  sampleNumber: number // Add sample number to track position in sequence
  values: number[]
}

export default function SensorDashboard() {
  // State for serial port connection
  const [port, setPort] = useState<SerialPort | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // State for data collection
  const [isCollecting, setIsCollecting] = useState(false)
  const [allSensorData, setAllSensorData] = useState<SensorReading[]>([]) // Store all data since start
  const [displayData, setDisplayData] = useState<SensorReading[]>([]) // Only for display (limited to 100)
  const reader = useRef<ReadableStreamDefaultReader | null>(null)
  const textDecoder = useRef(new TextDecoder())
  const dataBuffer = useRef("")
  const sampleCounter = useRef(0) // Track total samples collected

  // Mock data generation interval
  const mockDataInterval = useRef<NodeJS.Timeout | null>(null)

  // Connect to serial port
  const connectToDevice = async () => {
    try {
      if (connected) {
        // Disconnect
        if (reader.current) {
          await reader.current.cancel()
          reader.current = null
        }
        if (port) {
          await port.close()
          setPort(null)
        }
        setConnected(false)
        setError(null)
        return
      }

      // Request port access
      const selectedPort = await navigator.serial.requestPort()
      await selectedPort.open({ baudRate: 115200 })

      setPort(selectedPort)
      setConnected(true)
      setError(null)
    } catch (err) {
      console.error("Error connecting to serial device:", err)
      setError("Failed to connect to device. Please try again.")
      setConnected(false)
    }
  }

  // Add a new function to send commands over serial
  const sendSerialCommand = async (command: string) => {
    if (!port) return

    try {
      const writer = port.writable.getWriter()
      const encoder = new TextEncoder()
      const data = encoder.encode(command)
      await writer.write(data)
      writer.releaseLock()
    } catch (err) {
      console.error("Error sending command to device:", err)
      setError(`Failed to send ${command.trim()} command to device.`)
    }
  }

  // Start/stop data collection
  const toggleDataCollection = async () => {
    if (isCollecting) {
      // Stop collecting
      if (mockDataInterval.current) {
        clearInterval(mockDataInterval.current)
        mockDataInterval.current = null
      }

      // Send stop command if connected
      if (connected && port) {
        await sendSerialCommand("stop\n")
      }

      setIsCollecting(false)
    } else {
      // Reset sample counter when starting new collection
      sampleCounter.current = 0

      // Send start command if connected
      if (connected && port) {
        await sendSerialCommand("start\n")
      }

      // Always use mock data for now, as specified
      startMockData()
      setIsCollecting(true)
    }
  }

  // Read data from serial port
  const startReadingData = async () => {
    if (!port) return

    try {
      const inputStream = port.readable
      reader.current = inputStream.getReader()

      // Read loop
      const readLoop = async () => {
        try {
          while (isCollecting && reader.current) {
            const { value, done } = await reader.current.read()
            if (done) break

            // Process the received data
            const text = textDecoder.current.decode(value)
            processSerialData(text)
          }
        } catch (err) {
          console.error("Error reading from serial port:", err)
          setError("Error reading data from device.")
        }
      }

      readLoop()
    } catch (err) {
      console.error("Error setting up serial read:", err)
      setError("Failed to start data collection.")
    }
  }

  // Process incoming serial data
  const processSerialData = (text: string) => {
    // Append new text to buffer
    dataBuffer.current += text

    // Process complete lines
    const lines = dataBuffer.current.split("\n")

    // Keep the last incomplete line in the buffer
    dataBuffer.current = lines.pop() || ""

    // Process each complete line
    lines.forEach((line) => {
      if (line.trim()) {
        try {
          // Parse comma-separated values
          const values = line.split(",").map((val) => Number.parseInt(val.trim(), 10))

          // Ensure we have exactly 4 values
          if (values.length === 4 && values.every((v) => !isNaN(v))) {
            addSensorReading(values)
          }
        } catch (err) {
          console.warn("Invalid data format:", line)
        }
      }
    })
  }

  // Generate mock data for testing
  const startMockData = () => {
    mockDataInterval.current = setInterval(() => {
      // Generate 4 random values between 0 and 1023 (10-bit ADC)
      const mockValues = Array.from({ length: 4 }, () => Math.floor(Math.random() * 1024))
      addSensorReading(mockValues)
    }, 500) // Generate data every 500ms
  }

  // Add a new sensor reading to the data array
  const addSensorReading = (values: number[]) => {
    // Increment sample counter
    const currentSample = sampleCounter.current++

    const newReading = {
      timestamp: Date.now(),
      sampleNumber: currentSample,
      values: values,
    }

    // Add to complete dataset (all data since start)
    setAllSensorData((prevData) => [...prevData, newReading])

    // Update display data (limited to last 100 readings)
    setDisplayData((prevData) => {
      const updatedData = [...prevData, newReading]
      if (updatedData.length > 100) {
        return updatedData.slice(-100)
      }
      return updatedData
    })
  }

  // Export data as CSV - now uses allSensorData to include all readings
  const exportToCsv = () => {
    if (allSensorData.length === 0) return

    // Create CSV content
    const headers = "Timestamp,Sample,ADC1,ADC2,ADC3,ADC4\n"
    const rows = allSensorData
      .map((reading) => {
        const date = new Date(reading.timestamp).toISOString()
        return `${date},${reading.sampleNumber},${reading.values.join(",")}`
      })
      .join("\n")

    const csvContent = `data:text/csv;charset=utf-8,${headers}${rows}`
    const encodedUri = encodeURI(csvContent)

    // Create download link and trigger download
    const link = document.createElement("a")
    link.setAttribute("href", encodedUri)
    link.setAttribute("download", `adc_data_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // Reset all data when starting new collection
  useEffect(() => {
    if (isCollecting) {
      // Only clear data when starting a new collection
      if (allSensorData.length > 0) {
        setAllSensorData([])
        setDisplayData([])
      }
    }
  }, [isCollecting])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (mockDataInterval.current) {
        clearInterval(mockDataInterval.current)
      }
      if (reader.current) {
        reader.current.cancel()
      }
    }
  }, [])

  // Prepare chart data for Chart.js - using displayData for the chart
  // Now using actual sample numbers for x-axis
  const chartData = {
    labels: displayData.map((reading) => reading.sampleNumber.toString()),
    datasets: [
      {
        label: "ADC 1",
        data: displayData.map((reading) => reading.values[0]),
        borderColor: "rgb(255, 99, 132)",
        backgroundColor: "rgba(255, 99, 132, 0.5)",
        tension: 0.1,
        pointRadius: 0,
      },
      {
        label: "ADC 2",
        data: displayData.map((reading) => reading.values[1]),
        borderColor: "rgb(53, 162, 235)",
        backgroundColor: "rgba(53, 162, 235, 0.5)",
        tension: 0.1,
        pointRadius: 0,
      },
      {
        label: "ADC 3",
        data: displayData.map((reading) => reading.values[2]),
        borderColor: "rgb(75, 192, 192)",
        backgroundColor: "rgba(75, 192, 192, 0.5)",
        tension: 0.1,
        pointRadius: 0,
      },
      {
        label: "ADC 4",
        data: displayData.map((reading) => reading.values[3]),
        borderColor: "rgb(255, 159, 64)",
        backgroundColor: "rgba(255, 159, 64, 0.5)",
        tension: 0.1,
        pointRadius: 0,
      },
    ],
  }

  // Chart.js options with dynamic x-axis
  const chartOptions: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      y: {
        min: 0,
        max: 1023,
        title: {
          display: true,
          text: "Value",
        },
      },
      x: {
        title: {
          display: true,
          text: "Sample",
        },
        // Only show a subset of labels to avoid overcrowding
        ticks: {
          maxTicksLimit: 10,
          callback: (value, index, values) => {
            // Show actual sample number
            return displayData[index]?.sampleNumber
          },
        },
      },
    },
    animation: {
      duration: 0, // Disable animations for better performance
    },
    plugins: {
      legend: {
        position: "top" as const,
      },
      title: {
        display: false,
      },
      tooltip: {
        mode: "index",
        intersect: false,
        callbacks: {
          title: (tooltipItems) => {
            // Show actual sample number in tooltip
            const index = tooltipItems[0].dataIndex
            return `Sample: ${displayData[index]?.sampleNumber}`
          },
        },
      },
    },
    interaction: {
      mode: "nearest",
      axis: "x",
      intersect: false,
    },
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Updated button container with fixed positioning */}
      <div className="grid grid-cols-3 gap-4">
        <div className="flex justify-start">
          <Button
            onClick={connectToDevice}
            variant={connected ? "destructive" : "default"}
            className="w-36 flex items-center justify-center gap-2"
          >
            {connected ? (
              <>
                <PowerOff className="h-4 w-4" /> Disconnect
              </>
            ) : (
              <>
                <Power className="h-4 w-4" /> Connect Device
              </>
            )}
          </Button>
        </div>

        <div className="flex justify-center">
          <Button
            onClick={toggleDataCollection}
            variant="secondary"
            disabled={!connected && !isCollecting}
            className="w-36 flex items-center justify-center gap-2"
          >
            {isCollecting ? (
              <>
                <Pause className="h-4 w-4" /> Stop
              </>
            ) : (
              <>
                <Play className="h-4 w-4" /> Start
              </>
            )}
          </Button>
        </div>

        <div className="flex justify-end">
          <Button
            onClick={exportToCsv}
            variant="outline"
            disabled={allSensorData.length === 0}
            className="w-36 flex items-center justify-center gap-2"
          >
            <Download className="h-4 w-4" /> Export CSV
            {allSensorData.length > 0 && (
              <span className="ml-1 text-xs bg-secondary px-1.5 py-0.5 rounded-full">{allSensorData.length}</span>
            )}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>ADC Sensor Readings</CardTitle>
        </CardHeader>
        <CardContent>
          {displayData.length > 0 ? (
            <div className="w-full h-[400px]">
              <Line data={chartData} options={chartOptions} />
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              No data available. Connect to a device and start data collection.
            </div>
          )}
        </CardContent>
      </Card>

      {displayData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Latest Readings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {displayData[displayData.length - 1]?.values.map((value, index) => (
                <div key={index} className="p-4 border rounded-lg text-center">
                  <div className="text-sm text-muted-foreground">ADC {index + 1}</div>
                  <div className="text-2xl font-bold">{value}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
