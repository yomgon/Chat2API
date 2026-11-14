import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { TrendingUp, CheckCircle, XCircle, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface RequestLogStatsData {
  totalRequests: number
  successRequests: number
  failedRequests: number
}

interface RequestLogStatsProps {
  stats: RequestLogStatsData | null
  isLoading?: boolean
}

export function RequestLogStats({ stats, isLoading = false }: RequestLogStatsProps) {
  const { t } = useTranslation()
  const unavailable = isLoading ? t('common.loading') : t('models.unavailable')
  const successRate = stats && stats.totalRequests > 0
    ? Math.round((stats.successRequests / stats.totalRequests) * 100)
    : 0

  const statCards = [
    {
      label: t('logs.todayRequests'),
      value: stats?.totalRequests ?? unavailable,
      icon: TrendingUp,
      color: 'text-primary',
    },
    {
      label: t('logs.todaySuccess'),
      value: stats?.successRequests ?? unavailable,
      icon: CheckCircle,
      color: 'text-green-500',
    },
    {
      label: t('logs.todayErrors'),
      value: stats?.failedRequests ?? unavailable,
      icon: XCircle,
      color: 'text-red-500',
    },
    {
      label: t('dashboard.successRate'),
      value: stats ? `${successRate}%` : unavailable,
      icon: Activity,
      color: 'text-blue-500',
    },
  ]

  return (
    <div className="grid grid-cols-4 gap-4">
      {statCards.map((stat, index) => (
        <Card key={index} hover className="bg-muted/30 border-0 shadow-none">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
                <stat.icon className={cn('h-4 w-4', stat.color)} />
              </div>
            </div>
            <p className="text-2xl font-bold">{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
