"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

interface CalculationStep {
  category: string
  step: string
  formula: string
  calculation: string
  result: number
  description: string
}

export function CalculationDemo() {
  const [currentStep, setCurrentStep] = useState(0)
  const [isCalculating, setIsCalculating] = useState(false)
  const [completedSteps, setCompletedSteps] = useState<CalculationStep[]>([])

  const calculationSteps: CalculationStep[] = [
    {
      category: "Indications",
      step: "Direction Indication Configs",
      formula: "6 ranges × 5 price_ratios × 2 variations",
      calculation: "6 × 5 × 2",
      result: 60,
      description: "Each config generates up to 250 pseudo positions",
    },
    {
      category: "Indications",
      step: "Direction Pseudo Positions",
      formula: "60 configs × 250 positions",
      calculation: "60 × 250",
      result: 15000,
      description: "Total pseudo positions for direction indications",
    },
    {
      category: "Indications",
      step: "Move Indication Configs",
      formula: "6 ranges × 5 price_ratios × 2 variations",
      calculation: "6 × 5 × 2",
      result: 60,
      description: "Move detection configurations",
    },
    {
      category: "Indications",
      step: "Move Pseudo Positions",
      formula: "60 configs × 250 positions",
      calculation: "60 × 250",
      result: 15000,
      description: "Total pseudo positions for move indications",
    },
    {
      category: "Indications",
      step: "Active Indication Configs",
      formula: "5 thresholds × 3 time_variations",
      calculation: "5 × 3",
      result: 15,
      description: "Active trading threshold configurations",
    },
    {
      category: "Indications",
      step: "Active Pseudo Positions",
      formula: "15 configs × 250 positions",
      calculation: "15 × 250",
      result: 3750,
      description: "Total pseudo positions for active indications",
    },
    {
      category: "Strategies",
      step: "Base Strategy Configs",
      formula: "21 TP × 21 SL × 10 trailing (limited to 50)",
      calculation: "min(21 × 21 × 10, 50)",
      result: 50,
      description: "Base strategy parameter combinations",
    },
    {
      category: "Strategies",
      step: "Base Strategy Positions",
      formula: "50 configs × 150 positions",
      calculation: "50 × 150",
      result: 7500,
      description: "Pseudo positions for base strategies",
    },
    {
      category: "Strategies",
      step: "Count Strategy Configs",
      formula: "50 base_configs × 4 count_variations",
      calculation: "50 × 4",
      result: 200,
      description: "Count strategies (2,4,6,8 positions)",
    },
    {
      category: "Strategies",
      step: "Count Strategy Positions",
      formula: "200 configs × 150 positions",
      calculation: "200 × 150",
      result: 30000,
      description: "Pseudo positions for count strategies",
    },
    {
      category: "Strategies",
      step: "Block Strategy Configs",
      formula: "50 base × 3 block_sizes × 3 factors",
      calculation: "50 × 3 × 3",
      result: 450,
      description: "Block strategies with volume adjustments",
    },
    {
      category: "Strategies",
      step: "Block Strategy Positions",
      formula: "450 configs × 150 positions",
      calculation: "450 × 150",
      result: 67500,
      description: "Pseudo positions for block strategies",
    },
    {
      category: "Summary",
      step: "Total XRPUSDT Positions",
      formula: "Sum of all position types",
      calculation: "15000 + 15000 + 3750 + 7500 + 30000 + 67500",
      result: 138750,
      description: "Complete pseudo position count for one symbol",
    },
    {
      category: "Database",
      step: "DB Entries Per Minute",
      formula: "Total positions + 10% new positions",
      calculation: "138750 + (138750 × 0.1)",
      result: 152625,
      description: "Database writes per minute for real-time updates",
    },
    {
      category: "Scaling",
      step: "10 Symbols Total",
      formula: "138750 positions × 10 symbols",
      calculation: "138750 × 10",
      result: 1387500,
      description: "System-wide pseudo positions across multiple symbols",
    },
  ]

  const runCalculation = async () => {
    setIsCalculating(true)
    setCompletedSteps([])
    setCurrentStep(0)

    for (let i = 0; i < calculationSteps.length; i++) {
      setCurrentStep(i)
      await new Promise((resolve) => setTimeout(resolve, 800)) // Simulate calculation time
      setCompletedSteps((prev) => [...prev, calculationSteps[i]])
    }

    setIsCalculating(false)
  }

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "Indications":
        return "bg-blue-500"
      case "Strategies":
        return "bg-green-500"
      case "Summary":
        return "bg-purple-500"
      case "Database":
        return "bg-orange-500"
      case "Scaling":
        return "bg-red-500"
      default:
        return "bg-gray-500"
    }
  }

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat().format(num)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Live Position Calculation Demo</CardTitle>
          <CardDescription>Watch how CTS v3 calculates pseudo positions for XRPUSDT in real-time</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 mb-6">
            <Button onClick={runCalculation} disabled={isCalculating} className="min-w-32">
              {isCalculating ? "Calculating..." : "Run Demo"}
            </Button>
            {isCalculating && (
              <div className="flex-1">
                <Progress value={(currentStep / calculationSteps.length) * 100} className="h-2" />
                <p className="text-sm text-muted-foreground mt-1">
                  Step {currentStep + 1} of {calculationSteps.length}
                </p>
              </div>
            )}
          </div>

          <div className="space-y-4 max-h-96 overflow-y-auto">
            {completedSteps.map((step, index) => (
              <div key={index} className="flex items-center gap-4 py-2 px-4 border rounded-lg bg-muted/30">
                <Badge className={getCategoryColor(step.category)}>{step.category}</Badge>
                <div className="flex-1">
                  <div className="font-semibold">{step.step}</div>
                  <div className="text-sm text-muted-foreground">{step.description}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm text-muted-foreground">{step.formula}</div>
                  <div className="font-mono text-sm">{step.calculation}</div>
                  <div className="font-bold text-lg">{formatNumber(step.result)}</div>
                </div>
              </div>
            ))}

            {isCalculating && currentStep < calculationSteps.length && (
              <div className="flex items-center gap-4 py-2 px-4 border rounded-lg bg-primary/10 animate-pulse">
                <Badge className={getCategoryColor(calculationSteps[currentStep].category)}>
                  {calculationSteps[currentStep].category}
                </Badge>
                <div className="flex-1">
                  <div className="font-semibold">{calculationSteps[currentStep].step}</div>
                  <div className="text-sm text-muted-foreground">Calculating...</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm text-muted-foreground">{calculationSteps[currentStep].formula}</div>
                  <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full"></div>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {completedSteps.length === calculationSteps.length && (
        <Card>
          <CardHeader>
            <CardTitle>Key Insights from Calculation</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <h4 className="font-semibold text-green-600">Position Limits Explained</h4>
                <ul className="space-y-2 text-sm">
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-blue-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>250 limit per indication config:</strong> Each of the 135 indication configurations can
                      generate up to 250 pseudo positions independently
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-green-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>150 limit per strategy config:</strong> Each of the 700 strategy configurations manages up
                      to 150 positions separately
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-purple-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>Limits are NOT shared:</strong> Total system can handle 138,750+ positions per symbol
                      because each config has its own limit
                    </span>
                  </li>
                </ul>
              </div>

              <div className="space-y-3">
                <h4 className="font-semibold text-orange-600">System Performance</h4>
                <ul className="space-y-2 text-sm">
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-orange-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>152,625 DB writes/minute:</strong> For continuous real-time position updates on XRPUSDT
                      alone
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-red-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>1.38M+ positions total:</strong> When trading 10 symbols simultaneously with full
                      configuration coverage
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 bg-gray-500 rounded-full mt-2 flex-shrink-0"></span>
                    <span>
                      <strong>20% rearrangement:</strong> Positions automatically optimized when 20% become profitable
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
