"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "../components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Alert, AlertDescription } from "../components/ui/alert"
import {
  Download,
  Pause,
  Play,
  Power,
  PowerOff,
  Sliders,
  BarChart,
  Activity,
  Settings,
  Timer,
  Square,
} from "lucide-react"
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
import { Slider } from "./ui/slider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import 'katex/dist/katex.min.css';
import { InlineMath } from 'react-katex';

// Register Chart.js components
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend)

// Define the data structure for sensor readings
interface SensorReading {
  timestamp: number
  sampleNumber: number
  values: number[] // Now 12 values: 4 sensors with x, y, z components each
}

// Force component labels
const FORCE_COMPONENTS = ["X", "Y", "Z"]
const SENSOR_NAMES = ["Left Hand", "Right Hand", "Left Foot", "Right Foot"]

// Sample count options
const SAMPLE_COUNT_OPTIONS = [
  { value: "250", label: "Last 250 samples (2.5 Seconds)" },
  { value: "500", label: "Last 500 samples (5 Seconds)" },
  { value: "1000", label: "Last 1000 samples (10 Seconds)" },
  { value: "all", label: "All samples" },
]

export default function SensorDashboard() {
  // State for serial port connection
  const [port, setPort] = useState<SerialPort | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("norms")

  // Jump test state
  const [jumpNumber, setJumpNumber] = useState<number | null>(null)
  const [jumpTestActive, setJumpTestActive] = useState(false)
  const [jumpTestStatus, setJumpTestStatus] = useState<"idle" | "waiting" | "completed">("idle")
  const [countdown, setCountdown] = useState(10);
  const [timerActive, setTimerActive] = useState(false);
  // Body weight and wall angle state
  const [bodyWeight, setBodyWeight] = useState<string>("")
  const [bodyWeightSubmitted, setBodyWeightSubmitted] = useState<number | null>(null)
  const [wallAngle, setWallAngle] = useState<string>("")
  const [wallAngleSubmitted, setWallAngleSubmitted] = useState<number | null>(null)

  // Configuration state - SINGLE variable for display sample count
  const [displaySampleCount, setDisplaySampleCount] = useState<number | "all">(250)
  const [autoScaleY, setAutoScaleY] = useState(false)
  const [yAxisMax, setYAxisMax] = useState(1023)

  // State for data collection
  const [isCollecting, setIsCollecting] = useState(false)
  const isCollectingRef = useRef(false)
  const [totalSamples, setTotalSamples] = useState(0) // Simple counter for UI badges
  const [displayData, setDisplayData] = useState<SensorReading[]>([]) // Only for display
  const serialReaderActive = useRef(false)
  const textDecoder = useRef(new TextDecoder())
  const dataBuffer = useRef("")
  const sampleCounter = useRef(0) // Track total samples collected
  const allSensorDataRef = useRef<SensorReading[]>([]) // Mutable buffer for incoming data (no re-renders)
  const syncIntervalRef = useRef<NodeJS.Timeout | null>(null) // Throttled UI sync interval
  const displaySampleCountRef = useRef<number | "all">(250) // Mirror displaySampleCount for use in interval
  const autoScaleYRef = useRef(false) // Track autoScaleY in ref for use in addSensorReading
  const yAxisMaxRef = useRef(1023) // Track running Y max in ref
  const tareOffsets = useRef<number[]>(new Array(12).fill(0)) // Tare offsets for calibration
  const [calibrationMessage, setCalibrationMessage] = useState<string | null>(null)

  // Mock data generation interval
  const mockDataInterval = useRef<NodeJS.Timeout | null>(null)
  const mockModeActive = useRef(false)

  // Keep refs in sync with state
  useEffect(() => {
    autoScaleYRef.current = autoScaleY
  }, [autoScaleY])

  useEffect(() => {
    displaySampleCountRef.current = displaySampleCount
    // When sample count changes while not collecting, recompute display from ref
    if (!isCollecting && allSensorDataRef.current.length > 0) {
      const data = allSensorDataRef.current
      const count = displaySampleCount
      setDisplayData(count === "all" ? [...data] : data.slice(-count))
    }
  }, [displaySampleCount])

  // Throttled sync: compute display slice directly from ref at ~20fps
  useEffect(() => {
    if (!isCollecting) {
      // Final sync when stopping
      if (allSensorDataRef.current.length > 0) {
        const data = allSensorDataRef.current
        const count = displaySampleCountRef.current
        setDisplayData(count === "all" ? [...data] : data.slice(-count))
        setTotalSamples(data.length)
        if (autoScaleYRef.current) {
          setYAxisMax(yAxisMaxRef.current)
        }
      }
      return
    }

    syncIntervalRef.current = setInterval(() => {
      const data = allSensorDataRef.current
      const count = displaySampleCountRef.current
      // Only slice the display window — never copy the entire array
      setDisplayData(count === "all" ? [...data] : data.slice(-count))
      setTotalSamples(data.length)
      if (autoScaleYRef.current) {
        setYAxisMax(yAxisMaxRef.current)
      }
    }, 50) // Sync to state at ~20fps

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
        syncIntervalRef.current = null
      }
    }
  }, [isCollecting])

  useEffect(() => {
    if (!timerActive) return;

    if (countdown === 0) {
      setTimerActive(false);
      return;
    }

    const timerId = setTimeout(() => {
      setCountdown(countdown - 1);
    }, 1000);

    return () => clearTimeout(timerId);
  }, [countdown, timerActive]);


  // Connect to serial port
  const connectToDevice = async () => {
    try {
      if (connected) {
        // Disconnect
        // Stop data collection if it's running
        if (isCollectingRef.current) {
          isCollectingRef.current = false
          setIsCollecting(false)
        }

        // Reset jump test state
        setJumpTestActive(false)
        setJumpTestStatus("idle")

        // Signal to stop the serial reader
        serialReaderActive.current = false

        // Close the port
        if (port) {
          await port.close()
          setPort(null)
        }

        setConnected(false)
        setError(null)
        mockModeActive.current = false
        return
      }

      // Request port access
      try {
        const selectedPort = await navigator.serial.requestPort()
        await selectedPort.open({ baudRate: 115200 })

        setPort(selectedPort)
        setConnected(true)
        setError(null)
        mockModeActive.current = false

        // Start the serial reader
        serialReaderActive.current = true
        readSerialData(selectedPort)
      } catch (err) {
        console.error("Error opening serial port:", err)
        setError("Failed to open serial port. Please try again.")
        // Fall back to mock mode
        setConnected(false)
        mockModeActive.current = true
      }
    } catch (err) {
      console.error("Error connecting to serial device:", err)
      setError("Failed to connect to device. Please try again.")
      setConnected(false)
    }
  }

  // Read serial data continuously
  const readSerialData = async (serialPort: SerialPort) => {
    if (!serialPort || !serialPort.readable) {
      return
    }

    try {
      const reader = serialPort.readable.getReader()

      try {
        while (serialReaderActive.current) {
          const { value, done } = await reader.read()

          if (done) {
            break
          }

          if (value) {
            const text = textDecoder.current.decode(value)
            processSerialData(text)
          }
        }
      } catch (error) {
        console.error("Error reading from serial port:", error)
      } finally {
        reader.releaseLock()
      }
    } catch (error) {
      console.error("Error setting up serial reader:", error)
    }
  }

  // Send command over serial
  const sendSerialCommand = async (command: string) => {
    if (!port) {
      return
    }

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

  // Calibrate the device — tares the system by capturing current values as offsets
  const calibrateDevice = async () => {
    if (!connected && !mockModeActive.current) {
      setError("Connect to a device first")
      return
    }

    // Capture the latest sensor values as tare offsets
    const latestData = allSensorDataRef.current
    if (latestData.length > 0) {
      const lastReading = latestData[latestData.length - 1]
      tareOffsets.current = [...lastReading.values]
    } else {
      // No data yet — reset offsets to zero
      tareOffsets.current = new Array(12).fill(0)
    }

    if (connected && port) {
      try {
        await sendSerialCommand("calibrate\n")
        setError(null)
      } catch (err) {
        console.error("Error calibrating device:", err)
        setError("Failed to calibrate device. Please try again.")
        return
      }
    }

    // Show success message and auto-clear after 3 seconds
    setCalibrationMessage("System calibrated — all force values tared to zero.")
    setTimeout(() => setCalibrationMessage(null), 3000)
  }

  // Start jump test
  const startJumpTest = async () => {
    if (!connected && !mockModeActive.current) {
      setError("Connect to a device first")
      return
    }

    // Reset jump number and set status to waiting
    setJumpNumber(null)
    setJumpTestStatus("waiting")
    setJumpTestActive(true)
    setCountdown(10);
    setTimerActive(true);
    if (connected && port) {
      try {
        // Send start_jump command
        await sendSerialCommand("start_jump\n")
        setCountdown(10);
        setTimerActive(true);
      } catch (err) {
        console.error("Error starting jump test:", err)
        setError("Failed to start jump test. Please try again.")
        setJumpTestStatus("idle")
        setJumpTestActive(false)
      }
    } else if (mockModeActive.current) {
      // Mock jump test
      mockJumpTest()
    }
  }

  // Finish jump test
  const finishJumpTest = async () => {
    if (!connected && !mockModeActive.current) {
      setError("Connect to a device first")
      return
    }

    if (!jumpTestActive) {
      setError("No jump test is currently active")
      return
    }

    if (connected && port) {
      try {
        // Send stop_jump command
        await sendSerialCommand("stop_jump\n")
        setError(null)
      } catch (err) {
        console.error("Error finishing jump test:", err)
        setError("Failed to finish jump test. Please try again.")
      }
    } else if (mockModeActive.current) {
      // Mock finish jump test
      setTimeout(() => {
        const mockJumpValue = Math.floor(Math.random() * 100) + 20 // Random number between 20-120
        setJumpNumber(mockJumpValue)
        setJumpTestStatus("completed")
        setJumpTestActive(false)
      }, 500)
    }
  }

  // Send body weight through serial
  const sendBodyWeight = async () => {
    if (!bodyWeight || isNaN(Number(bodyWeight))) {
      setError("Please enter a valid body weight")
      return
    }

    const weight = Number(bodyWeight)
    if (weight <= 0 || weight > 500) {
      setError("Please enter a valid body weight between 1 and 500 kg")
      return
    }

    if (!connected && !mockModeActive.current) {
      setError("Connect to a device first")
      return
    }

    try {
      if (connected && port) {
        await sendSerialCommand(`mass:${weight}\n`)
        setBodyWeightSubmitted(weight)
        setError(null)
      } else if (mockModeActive.current) {
        // Mock body weight submission
        setBodyWeightSubmitted(weight)
      }
    } catch (err) {
      console.error("Error sending body weight:", err)
      setError("Failed to send body weight. Please try again.")
    }
  }

  // Send wall angle through serial
  const sendWallAngle = async () => {
    if (!wallAngle || isNaN(Number(wallAngle))) {
      setError("Please enter a valid wall angle")
      return
    }

    const angle = Number(wallAngle)
    if (angle < 0 || angle > 90) {
      setError("Please enter a valid wall angle between 0 and 90 degrees")
      return
    }

    if (!connected && !mockModeActive.current) {
      setError("Connect to a device first")
      return
    }

    try {
      if (connected && port) {
        await sendSerialCommand(`angle:${angle}\n`)
        setWallAngleSubmitted(angle)
        setError(null)
      } else if (mockModeActive.current) {
        // Mock wall angle submission
        setWallAngleSubmitted(angle)
      }
    } catch (err) {
      console.error("Error sending wall angle:", err)
      setError("Failed to send wall angle. Please try again.")
    }
  }

  // Start/stop data collection
  const toggleDataCollection = async () => {
    if (isCollectingRef.current) {
      // Stop collecting
      isCollectingRef.current = false
      setIsCollecting(false)

      // Send stop command if connected
      if (connected && port) {
        // await sendSerialCommand("stop\n")
      }

      // Stop mock data if active
      if (mockDataInterval.current) {
        clearInterval(mockDataInterval.current)
        mockDataInterval.current = null
      }
    } else {
      // Reset sample counter when starting new collection
      sampleCounter.current = 0

      // Clear previous data (both ref and state)
      allSensorDataRef.current = []
      yAxisMaxRef.current = yAxisMax
      setTotalSamples(0)
      setDisplayData([])

      // Set collecting state
      isCollectingRef.current = true
      setIsCollecting(true)

      // Send start command if connected
      if (connected && port) {
        // await sendSerialCommand("start\n")
      } else if (mockModeActive.current) {
        // Start mock data generation
        startMockData()
      } else {
        // If not connected and not in mock mode, enable mock mode
        mockModeActive.current = true
        startMockData()
      }
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
      if (!line.trim()) return

      // Check for jump message
      const jumpMatch = line.match(/jump:\s+(\d+)/i)
      if (jumpMatch) {
        const jumpValue = Number.parseInt(jumpMatch[1], 10)
        setJumpNumber(jumpValue)
        setJumpTestStatus("completed")
        setJumpTestActive(false)
        return // Skip normal data processing for this line
      }

      // Process sensor data if collecting
      if (isCollectingRef.current) {
        try {
          // Parse comma-separated values - updated to handle negative numbers
          const values = line.split(",").map((val) => {
            const trimmed = val.trim()
            const parsed = Number.parseFloat(trimmed)
            return parsed
          })

          // Check if we have valid data - updated to allow negative numbers
          if (values.length === 12 && values.every((v) => !isNaN(v) && isFinite(v))) {
            addSensorReading(values)
          }
        } catch (err) {
          // Skip invalid data lines
        }
      }
    })
  }

  // Generate mock data for testing
  const startMockData = () => {
    // Clear any existing interval
    if (mockDataInterval.current) {
      clearInterval(mockDataInterval.current)
    }

    mockDataInterval.current = setInterval(() => {
      if (!isCollectingRef.current) {
        if (mockDataInterval.current) {
          clearInterval(mockDataInterval.current)
          mockDataInterval.current = null
        }
        return
      }

      // Generate 12 random values (4 sensors with x, y, z components each)
      const mockValues = Array.from({ length: 12 }, () => Math.floor(Math.random() * 1023))
      addSensorReading(mockValues)
    }, 10) // Generate data every 10ms
  }

  // Mock jump test for testing without hardware
  const mockJumpTest = () => {
  }

  // Add a new sensor reading to the data array (pushes to ref — no re-renders)
  const addSensorReading = (values: number[]) => {
    // Increment sample counter
    const currentSample = sampleCounter.current++

    // Apply tare offsets (subtract calibration values so readings are relative to zero)
    const taredValues = values.map((v, i) => v - tareOffsets.current[i])

    const newReading = {
      timestamp: Date.now(),
      sampleNumber: currentSample,
      values: taredValues,
    }

    // Push to mutable ref buffer — the sync interval will copy to state at ~20fps
    allSensorDataRef.current.push(newReading)

    // Track Y-axis max in ref if auto-scaling is enabled
    if (autoScaleYRef.current) {
      const maxValue = Math.max(...taredValues)
      yAxisMaxRef.current = Math.max(yAxisMaxRef.current, Math.ceil(maxValue * 1.1))
    }
  }

  // Handle sample count change - ONLY place where displaySampleCount is changed
  const handleSampleCountChange = (value: string) => {
    const newValue = value === "all" ? "all" : Number.parseInt(value)
    setDisplaySampleCount(newValue)
  }

  // Export data as CSV — uses ref for the most complete dataset
  const exportToCsv = () => {
    const dataToExport = allSensorDataRef.current
    if (dataToExport.length === 0) return

    // Create CSV content with headers for all 12 values
    const headers =
      "Timestamp,Sample," +
      SENSOR_NAMES.map((sensor) => FORCE_COMPONENTS.map((component) => `${sensor}_${component}`).join(",")).join(",") +
      "\n"

    const rows = dataToExport
      .map((reading) => {
        const date = new Date(reading.timestamp).toISOString()
        return `${date},${reading.sampleNumber},${reading.values.join(",")}`
      })
      .join("\n")

    // Use Blob instead of data URI to avoid browser size limits
    const blob = new Blob([headers + rows], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)

    // Create download link and trigger download
    const link = document.createElement("a")
    link.setAttribute("href", url)
    link.setAttribute("download", `force_data_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)

    // Clean up the object URL
    URL.revokeObjectURL(url)
  }

  // Clean up on unmount
  useEffect(() => {
    return () => {
      // Stop data collection
      isCollectingRef.current = false
      serialReaderActive.current = false

      // Clear sync interval
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
      }

      // Clear mock data interval
      if (mockDataInterval.current) {
        clearInterval(mockDataInterval.current)
      }

      // Close port
      if (port) {
        port.close().catch(console.error)
      }
    }
  }, [])

  // Simple moving average filter — smooths out quantization stair-steps
  const smoothData = (data: number[], windowSize = 5): number[] => {
    const half = Math.floor(windowSize / 2)
    return data.map((_, i) => {
      const start = Math.max(0, i - half)
      const end = Math.min(data.length, i + half + 1)
      let sum = 0
      for (let j = start; j < end; j++) sum += data[j]
      return sum / (end - start)
    })
  }

  // Helper function to get X, Y, Z data for a specific sensor
  const getSensorComponentData = (sensorIndex: number) => {
    const componentColors = [
      { border: "rgb(123, 104, 238)", background: "rgba(123, 104, 238, 0.5)" }, // X — purple
      { border: "rgb(112, 128, 144)", background: "rgba(112, 128, 144, 0.5)" }, // Y — slate
      { border: "rgb(255, 215, 0)", background: "rgba(255, 215, 0, 0.5)" },     // Z — gold
    ]

    return {
      labels: displayData.map((reading) => reading.sampleNumber.toString()),
      datasets: FORCE_COMPONENTS.map((component, componentIndex) => ({
        label: `${component} Force`,
        data: smoothData(displayData.map((reading) => reading.values[sensorIndex * 3 + componentIndex])),
        borderColor: componentColors[componentIndex].border,
        backgroundColor: componentColors[componentIndex].background,
        tension: 0.4,
        pointRadius: 0,
      })),
    }
  }

  // Helper function to get Euclidean norms for all sensors - CUSTOMIZABLE COLORS PER PLOT
  const getNormData = () => {
    // CUSTOMIZE COLORS HERE FOR THE MAGNITUDE COMPARISON PLOT
    const magnitudePlotColors = [
      { border: "rgb(53, 162, 235)", background: "rgba(53, 162, 235, 0.5)" }, // Sensor 1 - Crimson
      { border: "rgb(255, 99, 132)", background: "rgba(255, 99, 132, 0.5)" }, // Sensor 2 - Dodger Blue
      { border: "rgb(255, 159, 64)", background: "rgba(255, 159, 64, 0.5)" }, // Sensor 3 - Lime Green
      { border: "rgb(75, 192, 192)", background: "rgba(75, 192, 192, 0.5)" }, // Sensor 4 - Dark Orange
    ]

    return {
      labels: displayData.map((reading) => reading.sampleNumber.toString()),
      datasets: SENSOR_NAMES.map((sensor, sensorIndex) => {
        const rawNormData = displayData.map((reading) => {
          const x = reading.values[sensorIndex * 3 + 0] // X component
          const y = reading.values[sensorIndex * 3 + 1] // Y component
          const z = reading.values[sensorIndex * 3 + 2] // Z component
          return Math.sqrt(x * x + y * y + z * z) // Euclidean norm
        })

        return {
          label: sensor,
          data: smoothData(rawNormData),
          borderColor: magnitudePlotColors[sensorIndex].border,
          backgroundColor: magnitudePlotColors[sensorIndex].background,
          tension: 0.4,
          pointRadius: 0,
        }
      }),
    }
  }

  // Chart.js options
  const chartOptions: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      y: {
        max: yAxisMax,
        title: {
          display: true,
          text: "Force (N)",
        },
      },
      x: {
        title: {
          display: true,
          text: "Sample",
        },
        ticks: {
          maxTicksLimit: 10,
          callback: (value, index, values) => {
            return displayData[index]?.sampleNumber
          },
        },
      },
    },
    animation: {
      duration: 0,
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

      {calibrationMessage && (
        <Alert className="border-green-300 bg-green-50 text-green-800">
          <AlertDescription>{calibrationMessage}</AlertDescription>
        </Alert>
      )}

      {/* Fixed button container at the top */}
      <div className="sticky top-0 z-10 bg-background pt-2 pb-4">
        <div className="grid grid-cols-5 gap-4">
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

          <div className="flex justify-center">
            <Button
              onClick={calibrateDevice}
              variant="outline"
              disabled={!connected && !mockModeActive.current}
              className="w-36 flex items-center justify-center gap-2"
            >
              <Sliders className="h-4 w-4" /> Calibrate
            </Button>
          </div>

          <div className="flex justify-center">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-36 flex items-center justify-center gap-2">
                  <Settings className="h-4 w-4" /> Settings
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80">
                <div className="space-y-4">
                  <h4 className="font-medium">Display Settings</h4>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Display Samples:</label>
                    <Select value={displaySampleCount.toString()} onValueChange={handleSampleCountChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select sample count" />
                      </SelectTrigger>
                      <SelectContent>
                        {SAMPLE_COUNT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium">Y-Axis Maximum:</label>
                      <span className="text-sm">{yAxisMax}</span>
                    </div>
                    <Slider
                      value={[yAxisMax]}
                      min={100}
                      max={2000}
                      step={100}
                      onValueChange={(values) => setYAxisMax(values[0])}
                      disabled={autoScaleY}
                    />
                  </div>

                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      id="autoScale"
                      checked={autoScaleY}
                      onChange={(e) => setAutoScaleY(e.target.checked)}
                      className="rounded border-gray-300"
                    />
                    <label htmlFor="autoScale" className="text-sm font-medium">
                      Auto-scale Y-axis
                    </label>
                  </div>

                  <div className="flex items-center justify-between mt-2 pt-2 border-t">
                    <span className="text-sm font-medium">Total samples collected:</span>
                    <span className="text-sm font-bold">{totalSamples}</span>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={exportToCsv}
              variant="outline"
              disabled={totalSamples === 0 && allSensorDataRef.current.length === 0}
              className="w-36 flex items-center justify-center gap-2"
            >
              <Download className="h-4 w-4" /> Export CSV
              {totalSamples > 0 && (
                <span className="ml-1 text-xs bg-secondary px-1.5 py-0.5 rounded-full">{totalSamples}</span>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Connection Status */}
      <div className="flex items-center justify-between bg-muted p-2 rounded-md">
        <div className="flex items-center">
          <div
            className={`w-3 h-3 rounded-full mr-2 ${
              connected ? "bg-green-500" : mockModeActive.current ? "bg-yellow-500" : "bg-red-500"
            }`}
          ></div>
          <span className="text-sm">
            {connected
              ? "Connected to device"
              : mockModeActive.current
                ? "Mock mode active (no device)"
                : "Not connected"}
          </span>
        </div>
        <div className="text-sm">{isCollecting ? "Collecting data" : "Data collection stopped"}</div>
      </div>

      {/* Tabs for different views */}
      <Tabs defaultValue="norms" value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-3 mb-4">
          <TabsTrigger value="norms" className="flex items-center gap-2">
            <BarChart className="h-4 w-4" />
            Force Magnitudes
          </TabsTrigger>
          <TabsTrigger value="components" className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            X / Y / Z Components
          </TabsTrigger>
          <TabsTrigger value="jump" className="flex items-center gap-2">
            <Timer className="h-4 w-4" />
            Jump Test
          </TabsTrigger>
        </TabsList>

        {/* Force Magnitudes Tab */}
        <TabsContent value="norms" className="mt-0">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Force Magnitudes (Euclidean Norms)</CardTitle>
              <div className="text-sm text-muted-foreground">
                Displaying: {displaySampleCount === "all" ? "All" : `Last ${displaySampleCount}`} samples (
                {displayData.length} of {totalSamples} total)
              </div>
            </CardHeader>
            <CardContent>
              {displayData.length > 0 ? (
                <div className="border rounded-lg p-4">
                  <h3 className="text-lg font-medium mb-2">Force Magnitude: √(X² + Y² + Z²)</h3>
                  <div className="h-[400px]">
                    <Line data={getNormData()} options={chartOptions} />
                  </div>
                  <div className="mt-4 text-sm text-muted-foreground">
                    <p>This chart shows the Euclidean norm (magnitude) of the force vector for each sensor.</p>
                    <p>The magnitude represents the overall force strength regardless of direction.</p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  No data available. Connect to a device and start data collection.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* X / Y / Z Components Tab */}
        <TabsContent value="components" className="mt-0">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>X / Y / Z Force Components per Sensor</CardTitle>
              <div className="text-sm text-muted-foreground">
                Displaying: {displaySampleCount === "all" ? "All" : `Last ${displaySampleCount}`} samples (
                {displayData.length} of {totalSamples} total)
              </div>
            </CardHeader>
            <CardContent>
              {displayData.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {SENSOR_NAMES.map((sensor, index) => (
                    <div key={index} className="border rounded-lg p-4">
                      <h3 className="text-lg font-medium mb-2">{sensor}</h3>
                      <div className="h-[250px]">
                        <Line data={getSensorComponentData(index)} options={chartOptions} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  No data available. Connect to a device and start data collection.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Jump Test Tab */}
        <TabsContent value="jump" className="mt-0">
          <Card>
            <CardHeader>
              <CardTitle>Jump Height Test</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col items-center justify-center space-y-8 py-8">
                {/* Configuration Section */}
                <div className="w-full max-w-md space-y-6">
                  {/* Body Weight Input */}
                  <div className="border rounded-lg p-4 space-y-4">
                    <h3 className="text-lg font-medium">Body Weight</h3>
                    <div className="flex items-center gap-4">
                      <div className="flex-1">
                        <input
                          type="number"
                          value={bodyWeight}
                          onChange={(e) => setBodyWeight(e.target.value)}
                          placeholder="Enter weight in kg"
                          className="w-full px-3 py-2 border rounded-md"
                          min="1"
                          max="500"
                        />
                      </div>
                      <Button onClick={sendBodyWeight} variant="outline" className="whitespace-nowrap">
                        Set Weight
                      </Button>
                    </div>
                    {bodyWeightSubmitted && (
                      <div className="text-sm text-green-600">Current weight: {bodyWeightSubmitted} kg</div>
                    )}
                  </div>

                  {/* Wall Angle Input */}
                  <div className="border rounded-lg p-4 space-y-4">
                    <h3 className="text-lg font-medium">Wall Angle</h3>
                    <div className="flex items-center gap-4">
                      <div className="flex-1">
                        <input
                          type="number"
                          value={wallAngle}
                          onChange={(e) => setWallAngle(e.target.value)}
                          placeholder="Enter angle in degrees"
                          className="w-full px-3 py-2 border rounded-md"
                          min="0"
                          max="90"
                          step="0.1"
                        />
                      </div>
                      <Button onClick={sendWallAngle} variant="outline" className="whitespace-nowrap">
                        Set Angle
                      </Button>
                    </div>
                    {wallAngleSubmitted !== null && (
                      <div className="text-sm text-green-600">Current angle: {wallAngleSubmitted}°</div>
                    )}
                  </div>
                </div>

                {/* Jump Height Display */}
                {jumpNumber !== null && (
                  <div className="text-center p-6 bg-green-50 border border-green-200 rounded-lg w-full max-w-md">
                    {/* Mass Independent Score */}
                    {bodyWeightSubmitted > 0 && (
                      <div className="mt-4">
                        <div className="text-7xl font-semibold text-blue-700">
                          {(jumpNumber / Math.cbrt(bodyWeightSubmitted)).toFixed(1)}
                        </div>
                        <div className="text-6x1 text-blue-700">Mass Independent Score= <InlineMath math="\frac{\text{height}}{\sqrt[3]{\text{mass}}}" /> </div>
                      </div>
                    )}
                    <div className="text-4xl font-bold mb-2 text-green-700">{jumpNumber}</div>
                    <div className="text-xl text-green-600">Jump Height (cm)</div>
                  </div>
                )}

                {/* Status Display */}
                {jumpTestStatus === "waiting" && (
                  <div className="text-center p-6 bg-yellow-50 border border-yellow-200 rounded-lg w-full max-w-md">
                    <div className="text-xl font-medium text-yellow-700 mb-2">Jump Test in Progress</div>
                    <div className="text-sm text-yellow-600">
                      Perform your jump and click "Finish Jump" when completed.
                    </div>
                    <div className="text-lg font-semibold text-yellow-800 mb-1">Prepare for jump in:</div>
                    <div className="text-4xl font-bold text-yellow-900">{countdown}</div>
                  </div>
                )}

                {/* Jump Test Controls */}
                <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
                  <Button
                    onClick={startJumpTest}
                    disabled={jumpTestActive}
                    variant="default"
                    size="lg"
                    className="flex-1 h-16 text-lg"
                  >
                    <Timer className="h-5 w-5 mr-2" />
                    Start Jump
                  </Button>
                  <Button
                    onClick={finishJumpTest}
                    disabled={!jumpTestActive}
                    variant="destructive"
                    size="lg"
                    className="flex-1 h-16 text-lg"
                  >
                    <Square className="h-5 w-5 mr-2" />
                    Finish Jump
                  </Button>
                </div>

                {/* Instructions */}
                <div className="max-w-md text-center text-sm text-muted-foreground">
                  <p>
                    1. Configure your test parameters (body weight and wall angle)
                    <br />
                    2. Click "Start Jump" to begin the test
                    <br />
                    3. Perform your jump
                    <br />
                    4. Click "Finish Jump" to complete the test
                    <br />
                    5. The jump height will be displayed above
                  </p>
                  {!connected && mockModeActive.current && (
                    <p className="mt-2 text-yellow-500">
                      Note: You are currently in demo mode. Connect to a device for actual measurements.
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
