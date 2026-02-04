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
  Grid2X2,
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
  // Debug mode
  const [debugMode, setDebugMode] = useState(true)
  const [debugMessages, setDebugMessages] = useState<string[]>([])

  // State for serial port connection
  const [port, setPort] = useState<SerialPort | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("combined")

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
  const [displaySampleCount, setDisplaySampleCount] = useState<number | "all">(1000)
  const [autoScaleY, setAutoScaleY] = useState(false)
  const [yAxisMax, setYAxisMax] = useState(1023)

  // State for data collection
  const [isCollecting, setIsCollecting] = useState(false)
  const isCollectingRef = useRef(false)
  const [allSensorData, setAllSensorData] = useState<SensorReading[]>([]) // Store all data since start
  const [displayData, setDisplayData] = useState<SensorReading[]>([]) // Only for display
  const serialReaderActive = useRef(false)
  const textDecoder = useRef(new TextDecoder())
  const dataBuffer = useRef("")
  const sampleCounter = useRef(0) // Track total samples collected

  // Mock data generation interval
  const mockDataInterval = useRef<NodeJS.Timeout | null>(null)
  const mockModeActive = useRef(false)

  // Add debug message
  const addDebugMessage = (message: string) => {
    if (debugMode) {
      console.log(message)
      setDebugMessages((prev) => [message, ...prev].slice(0, 50)) // Keep last 50 messages
    }
  }

  // Helper function to update display data based on sample count - SINGLE SOURCE OF TRUTH
  const updateDisplayData = (allData: SensorReading[]) => {
    if (displaySampleCount === "all") {
      return [...allData]
    } else {
      return allData.slice(-displaySampleCount)
    }
  }

  // Effect to update display data whenever allSensorData or displaySampleCount changes
  useEffect(() => {
    const newDisplayData = updateDisplayData(allSensorData)
    setDisplayData(newDisplayData)
    if (allSensorData.length > 0) {
      addDebugMessage(
        `Display updated: showing ${newDisplayData.length} of ${allSensorData.length} total samples (setting: ${displaySampleCount})`,
      )
    }
  }, [allSensorData, displaySampleCount])

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
        addDebugMessage("Disconnecting from device...")

        // Stop data collection if it's running
        if (isCollectingRef.current) {
          isCollectingRef.current = false
          setIsCollecting(false)
          addDebugMessage("Stopping data collection")
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
          addDebugMessage("Port closed")
        }

        setConnected(false)
        setError(null)
        mockModeActive.current = false
        return
      }

      // Request port access
      addDebugMessage("Requesting serial port...")
      try {
        const selectedPort = await navigator.serial.requestPort()
        await selectedPort.open({ baudRate: 115200 })

        setPort(selectedPort)
        setConnected(true)
        setError(null)
        mockModeActive.current = false
        addDebugMessage("Connected to serial port")

        // Start the serial reader
        serialReaderActive.current = true
        readSerialData(selectedPort)
      } catch (err) {
        console.error("Error opening serial port:", err)
        setError("Failed to open serial port. Please try again.")
        // Fall back to mock mode
        setConnected(false)
        mockModeActive.current = true
        addDebugMessage("Failed to connect to device, falling back to mock mode")
      }
    } catch (err) {
      console.error("Error connecting to serial device:", err)
      setError("Failed to connect to device. Please try again.")
      setConnected(false)
    }
  }

  // Read serial data continuously
  const readSerialData = async (serialPort: SerialPort) => {
    addDebugMessage("Starting serial reader...")

    if (!serialPort || !serialPort.readable) {
      addDebugMessage("Error: Serial port is not readable")
      return
    }

    try {
      const reader = serialPort.readable.getReader()

      try {
        while (serialReaderActive.current) {
          const { value, done } = await reader.read()

          if (done) {
            addDebugMessage("Serial reader done (port closed)")
            break
          }

          if (value) {
            const text = textDecoder.current.decode(value)
            addDebugMessage(`Received data: ${text.trim()}`)
            processSerialData(text)
          }
        }
      } catch (error) {
        console.error("Error reading from serial port:", error)
        addDebugMessage(`Serial read error: ${error}`)
      } finally {
        reader.releaseLock()
        addDebugMessage("Serial reader released")
      }
    } catch (error) {
      console.error("Error setting up serial reader:", error)
      addDebugMessage(`Serial setup error: ${error}`)
    }
  }

  // Send command over serial
  const sendSerialCommand = async (command: string) => {
    if (!port) {
      addDebugMessage(`Cannot send command: ${command} - No port connected`)
      return
    }

    try {
      addDebugMessage(`Sending command: ${command.trim()}`)
      const writer = port.writable.getWriter()
      const encoder = new TextEncoder()
      const data = encoder.encode(command)
      await writer.write(data)
      writer.releaseLock()
      addDebugMessage(`Command sent: ${command.trim()}`)
    } catch (err) {
      console.error("Error sending command to device:", err)
      addDebugMessage(`Error sending command: ${err}`)
      setError(`Failed to send ${command.trim()} command to device.`)
    }
  }

  // Calibrate the device
  const calibrateDevice = async () => {
    if (!connected && !mockModeActive.current) {
      setError("Connect to a device first")
      return
    }

    if (connected && port) {
      try {
        await sendSerialCommand("calibrate\n")
        setError(null) // Clear any previous errors
      } catch (err) {
        console.error("Error calibrating device:", err)
        setError("Failed to calibrate device. Please try again.")
      }
    } else {
      // Mock calibration
      addDebugMessage("Mock calibration performed")
    }
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
    addDebugMessage("Jump test started")
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

    addDebugMessage("Finishing jump test")

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
        addDebugMessage(`Mock jump value: ${mockJumpValue}`)
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
        addDebugMessage(`Body weight sent: ${weight} kg`)
      } else if (mockModeActive.current) {
        // Mock body weight submission
        setBodyWeightSubmitted(weight)
        addDebugMessage(`Mock body weight sent: ${weight} kg`)
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
        addDebugMessage(`Wall angle sent: ${angle} degrees`)
      } else if (mockModeActive.current) {
        // Mock wall angle submission
        setWallAngleSubmitted(angle)
        addDebugMessage(`Mock wall angle sent: ${angle} degrees`)
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
      addDebugMessage("Stopping data collection")

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
      addDebugMessage("Starting data collection")

      // Clear previous data
      setAllSensorData([])

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
        addDebugMessage("Using mock data (no device connected)")
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
        addDebugMessage(`Jump value received: ${jumpValue} (cm)`)
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
          } else {
            addDebugMessage(`Invalid data format (expected 12 valid numbers): ${line}`)
          }
        } catch (err) {
          addDebugMessage(`Error parsing data: ${line}`)
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

    addDebugMessage("Starting mock data generation")

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
    addDebugMessage("Starting mock jump test")
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

    // Add to complete dataset - the useEffect will handle updating displayData
    setAllSensorData((prevData) => [...prevData, newReading])

    // Update Y-axis max if auto-scaling is enabled
    if (autoScaleY) {
      const minValue = Math.min(...values)
      const maxValue = Math.max(...values)
      setYAxisMax((prev) => Math.max(prev, Math.ceil(maxValue * 1.1)))
    }
  }

  // Handle sample count change - ONLY place where displaySampleCount is changed
  const handleSampleCountChange = (value: string) => {
    const newValue = value === "all" ? "all" : Number.parseInt(value)
    setDisplaySampleCount(newValue)
    addDebugMessage(`Display sample count changed to: ${newValue}`)
  }

  // Export data as CSV
  const exportToCsv = () => {
    if (allSensorData.length === 0) return

    // Create CSV content with headers for all 12 values
    const headers =
      "Timestamp,Sample," +
      SENSOR_NAMES.map((sensor) => FORCE_COMPONENTS.map((component) => `${sensor}_${component}`).join(",")).join(",") +
      "\n"

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
    link.setAttribute("download", `force_data_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // Clean up on unmount
  useEffect(() => {
    return () => {
      // Stop data collection
      isCollectingRef.current = false
      serialReaderActive.current = false

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

  // Helper function to get sensor data for a specific sensor - CUSTOMIZABLE COLORS PER PLOT
  const getSensorData = (sensorIndex: number) => {
    // CUSTOMIZE COLORS HERE FOR EACH SENSOR PLOT
    const plotColors = [
      // Sensor 1 colors
      {
        X: { border: "rgb(123, 104, 238)", background: "rgba(123, 104, 238, 0.5)" },
        Y: { border: "rgb(112, 128, 144)", background: "rgba(112, 128, 144, 0.5)" },
        Z: { border: "rgb(255, 215, 0)", background: "rgba(255, 215, 0, 0.5)" },
        Magnitude: { border: "rgb(53, 162, 235)", background: "rgba(53, 162, 235, 0.5)" },
      },
      // Sensor 2 colors
      {
        X: { border: "rgb(123, 104, 238)", background: "rgba(123, 104, 238, 0.5)" },
        Y: { border: "rgb(112, 128, 144)", background: "rgba(112, 128, 144, 0.5)" },
        Z: { border: "rgb(255, 215, 0)", background: "rgba(255, 215, 0, 0.5)" },
        Magnitude: { border: "rgb(255, 99, 132)", background: "rgba(255, 99, 132, 0.5)" },
      },
      // Sensor 3 colors
      {
         X: { border: "rgb(123, 104, 238)", background: "rgba(123, 104, 238, 0.5)" },
        Y: { border: "rgb(112, 128, 144)", background: "rgba(112, 128, 144, 0.5)" },
        Z: { border: "rgb(255, 215, 0)", background: "rgba(255, 215, 0, 0.5)" },
        Magnitude: { border: "rgb(255, 159, 64)", background: "rgba(255, 159, 64, 0.5)" },
      },
      // Sensor 4 colors
      {
        X: { border: "rgb(123, 104, 238)", background: "rgba(123, 104, 238, 0.5)" },
        Y: { border: "rgb(112, 128, 144)", background: "rgba(112, 128, 144, 0.5)" },
        Z: { border: "rgb(255, 215, 0)", background: "rgba(255, 215, 0, 0.5)" },
        Magnitude: { border: "rgb(75, 192, 192)", background: "rgba(75, 192, 192, 0.5)" },
      },
    ]

    const sensorColors = plotColors[sensorIndex]

    return {
      labels: displayData.map((reading) => reading.sampleNumber.toString()),
      datasets: [
        ...FORCE_COMPONENTS.map((component, componentIndex) => ({
          label: `${component} Force`,
          data: displayData.map((reading) => reading.values[sensorIndex * 3 + componentIndex]),
          borderColor: sensorColors[component as keyof typeof sensorColors].border,
          backgroundColor: sensorColors[component as keyof typeof sensorColors].background,
          tension: 0.1,
          pointRadius: 0,
        })),
        // Add magnitude dataset with sensor-specific color
        {
          label: "Magnitude",
          data: displayData.map((reading) => {
            const x = reading.values[sensorIndex * 3 + 0] // X component
            const y = reading.values[sensorIndex * 3 + 1] // Y component
            const z = reading.values[sensorIndex * 3 + 2] // Z component
            return Math.sqrt(x * x + y * y + z * z) // Euclidean norm
          }),
          borderColor: sensorColors.Magnitude.border,
          backgroundColor: sensorColors.Magnitude.background,
          tension: 0.1,
          pointRadius: 0,
          borderWidth: 2, // Make magnitude line slightly thicker
        },
      ],
    }
  }

  // Helper function to get data for a specific force component across all sensors - CUSTOMIZABLE COLORS PER PLOT
  const getComponentData = (componentIndex: number) => {
    // CUSTOMIZE COLORS HERE FOR EACH COMPONENT COMPARISON PLOT
    const componentPlotColors = [
      // X Component plot colors (comparing all sensors)
      [
        { border: "rgb(53, 162, 235)", background: "rgba(53, 162, 235, 0.5)" }, // Sensor 1 
        { border: "rgb(255, 99, 132)", background: "rgba(255, 99, 132, 0.5)" }, // Sensor 2
        { border: "rgb(255, 159, 64)", background: "rgba(255, 159, 64, 0.5)" }, // Sensor 3
        { border: "rgb(75, 192, 192)", background: "rgba(75, 192, 192, 0.5)" }, // Sensor 4 
      ],
      // Y Component plot colors (comparing all sensors)
      [
        { border: "rgb(53, 162, 235)", background: "rgba(53, 162, 235, 0.5)" }, // Sensor 1 
        { border: "rgb(255, 99, 132)", background: "rgba(255, 99, 132, 0.5)" }, // Sensor 2
        { border: "rgb(255, 159, 64)", background: "rgba(255, 159, 64, 0.5)" }, // Sensor 3
        { border: "rgb(75, 192, 192)", background: "rgba(75, 192, 192, 0.5)" }, // Sensor 4 
      ],
      // Z Component plot colors (comparing all sensors)
      [
        { border: "rgb(53, 162, 235)", background: "rgba(53, 162, 235, 0.5)" }, // Sensor 1 
        { border: "rgb(255, 99, 132)", background: "rgba(255, 99, 132, 0.5)" }, // Sensor 2
        { border: "rgb(255, 159, 64)", background: "rgba(255, 159, 64, 0.5)" }, // Sensor 3
        { border: "rgb(75, 192, 192)", background: "rgba(75, 192, 192, 0.5)" }, // Sensor 4 
      ],
    ]

    const plotColors = componentPlotColors[componentIndex]

    return {
      labels: displayData.map((reading) => reading.sampleNumber.toString()),
      datasets: SENSOR_NAMES.map((sensor, sensorIndex) => ({
        label: sensor,
        data: displayData.map((reading) => reading.values[sensorIndex * 3 + componentIndex]),
        borderColor: plotColors[sensorIndex].border,
        backgroundColor: plotColors[sensorIndex].background,
        tension: 0.1,
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
        const normData = displayData.map((reading) => {
          const x = reading.values[sensorIndex * 3 + 0] // X component
          const y = reading.values[sensorIndex * 3 + 1] // Y component
          const z = reading.values[sensorIndex * 3 + 2] // Z component
          return Math.sqrt(x * x + y * y + z * z) // Euclidean norm
        })

        return {
          label: sensor,
          data: normData,
          borderColor: magnitudePlotColors[sensorIndex].border,
          backgroundColor: magnitudePlotColors[sensorIndex].background,
          tension: 0.1,
          pointRadius: 0,
        }
      }),
    }
  }

  // Helper function to get colors for current readings progress bars - CUSTOMIZABLE COLORS PER SENSOR
  const getCurrentReadingColors = (sensorIndex: number) => {
    // CUSTOMIZE COLORS HERE FOR CURRENT READINGS PROGRESS BARS
    const progressBarColors = [
      // Sensor 1 progress bar colors
      {
        X: "rgb(123, 104, 238)",
        Y: "rgb(112, 128, 144)",
        Z: "rgb(255, 215, 0)",
        Magnitude: "rgb(53, 162, 235)",
      },
      // Sensor 2 progress bar colors
      {
        X: "rgb(123, 104, 238)",
        Y: "rgb(112, 128, 144)",
        Z: "rgb(255, 215, 0)",
        Magnitude: "rgb(255, 99, 132)",
      },
      // Sensor 3 progress bar colors
      {
        X: "rgb(123, 104, 238)",
        Y: "rgb(112, 128, 144)",
        Z: "rgb(255, 215, 0)",
        Magnitude: "rgb(255, 159, 64)",
      },
      // Sensor 4 progress bar colors
      {
        X: "rgb(123, 104, 238)",
        Y: "rgb(112, 128, 144)",
        Z: "rgb(255, 215, 0)",
        Magnitude: "rgb(75, 192, 192)",
      },
    ]

    return progressBarColors[sensorIndex]
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
          text: "Force Value",
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

                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      id="debugMode"
                      checked={debugMode}
                      onChange={(e) => setDebugMode(e.target.checked)}
                      className="rounded border-gray-300"
                    />
                    <label htmlFor="debugMode" className="text-sm font-medium">
                      Debug Mode
                    </label>
                  </div>

                  <div className="flex items-center justify-between mt-2 pt-2 border-t">
                    <span className="text-sm font-medium">Total samples collected:</span>
                    <span className="text-sm font-bold">{allSensorData.length}</span>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
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
      </div>

      {/* Debug Messages */}
      {debugMode && debugMessages.length > 0 && (
        <div className="bg-black text-green-400 p-4 rounded-md text-xs font-mono overflow-auto max-h-40">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-white">Debug Console</h3>
            <Button variant="outline" size="sm" onClick={() => setDebugMessages([])} className="h-6 text-xs">
              Clear
            </Button>
          </div>
          {debugMessages.map((msg, i) => (
            <div key={i} className="py-0.5">
              {msg}
            </div>
          ))}
        </div>
      )}

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
      <Tabs defaultValue="combined" value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-5 mb-4">
          <TabsTrigger value="combined" className="flex items-center gap-2">
            <Grid2X2 className="h-4 w-4" />
            Combined Forces
          </TabsTrigger>
          <TabsTrigger value="individual" className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Individual Forces
          </TabsTrigger>
          <TabsTrigger value="norms" className="flex items-center gap-2">
            <BarChart className="h-4 w-4" />
            Force Magnitudes
          </TabsTrigger>
          <TabsTrigger value="readings" className="flex items-center gap-2">
            <BarChart className="h-4 w-4" />
            Current Readings
          </TabsTrigger>
          <TabsTrigger value="jump" className="flex items-center gap-2">
            <Timer className="h-4 w-4" />
            Jump Test
          </TabsTrigger>
        </TabsList>

        {/* Combined Forces Tab */}
        <TabsContent value="combined" className="mt-0">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Force Readings (X, Y, Z per panel)</CardTitle>
              <div className="text-sm text-muted-foreground">
                Displaying: {displaySampleCount === "all" ? "All" : `Last ${displaySampleCount}`} samples (
                {displayData.length} of {allSensorData.length} total)
              </div>
            </CardHeader>
            <CardContent>
              {displayData.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {SENSOR_NAMES.map((sensor, index) => (
                    <div key={index} className="border rounded-lg p-4">
                      <h3 className="text-lg font-medium mb-2">{sensor}</h3>
                      <div className="h-[250px]">
                        <Line data={getSensorData(index)} options={chartOptions} />
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

        {/* Individual Forces Tab */}
        <TabsContent value="individual" className="mt-0">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Individual Force Components </CardTitle>
              <div className="text-sm text-muted-foreground">
                Displaying: {displaySampleCount === "all" ? "All" : `Last ${displaySampleCount}`} samples (
                {displayData.length} of {allSensorData.length} total)
              </div>
            </CardHeader>
            <CardContent>
              {displayData.length > 0 ? (
                <div className="space-y-8">
                  {FORCE_COMPONENTS.map((component, index) => (
                    <div key={index} className="border rounded-lg p-4">
                      <h3 className="text-lg font-medium mb-2">{component} Force Component</h3>
                      <div className="h-[250px]">
                        <Line data={getComponentData(index)} options={chartOptions} />
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

        {/* Force Magnitudes Tab */}
        <TabsContent value="norms" className="mt-0">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Force Magnitudes (Euclidean Norms)</CardTitle>
              <div className="text-sm text-muted-foreground">
                Displaying: {displaySampleCount === "all" ? "All" : `Last ${displaySampleCount}`} samples (
                {displayData.length} of {allSensorData.length} total)
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

        {/* Current Readings Tab */}
        <TabsContent value="readings" className="mt-0">
          <Card>
            <CardHeader>
              <CardTitle>Latest Force Readings</CardTitle>
            </CardHeader>
            <CardContent>
              {displayData.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  {SENSOR_NAMES.map((sensor, sensorIndex) => (
                    <div key={sensorIndex} className="border rounded-lg p-4">
                      <h3 className="text-lg font-medium mb-4 text-center">{sensor}</h3>
                      <div className="space-y-4">
                        {FORCE_COMPONENTS.map((component, componentIndex) => {
                          const value =
                            displayData[displayData.length - 1]?.values[sensorIndex * 3 + componentIndex] || 0
                          const colors = getCurrentReadingColors(sensorIndex)
                          return (
                            <div key={componentIndex} className="space-y-1">
                              <div className="flex justify-between items-center">
                                <span className="text-sm text-muted-foreground">{component} Force</span>
                              </div>
                              <div className="w-full bg-secondary rounded-full h-3">
                                <div
                                  className="h-3 rounded-full transition-all duration-300"
                                  style={{
                                    width: `${Math.min(Math.abs(value / yAxisMax) * 100, 100)}%`,
                                    backgroundColor: colors[component as keyof typeof colors],
                                  }}
                                ></div>
                              </div>
                            </div>
                          )
                        })}
                        {/* Add magnitude display */}
                        <div className="space-y-1 pt-2 border-t">
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-muted-foreground font-medium">Magnitude:</span>
                            <span className="font-bold text-primary">
                              {Math.round(
                                Math.sqrt(
                                  Math.pow(displayData[displayData.length - 1]?.values[sensorIndex * 3 + 0] || 0, 2) +
                                    Math.pow(displayData[displayData.length - 1]?.values[sensorIndex * 3 + 1] || 0, 2) +
                                    Math.pow(displayData[displayData.length - 1]?.values[sensorIndex * 3 + 2] || 0, 2),
                                ),
                              )}
                            </span>
                          </div>
                          <div className="w-full bg-secondary rounded-full h-4">
                            <div
                              className="h-4 rounded-full transition-all duration-300"
                              style={{
                                width: `${Math.min(
                                  (Math.sqrt(
                                    Math.pow(displayData[displayData.length - 1]?.values[sensorIndex * 3 + 0] || 0, 2) +
                                      Math.pow(
                                        displayData[displayData.length - 1]?.values[sensorIndex * 3 + 1] || 0,
                                        2,
                                      ) +
                                      Math.pow(
                                        displayData[displayData.length - 1]?.values[sensorIndex * 3 + 2] || 0,
                                        2,
                                      ),
                                  ) /
                                    yAxisMax) *
                                    100,
                                  100,
                                )}%`,
                                backgroundColor: getCurrentReadingColors(sensorIndex).Magnitude,
                              }}
                            ></div>
                          </div>
                        </div>
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
