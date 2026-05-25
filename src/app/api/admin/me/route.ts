import { NextRequest, NextResponse } from 'next/server'
import { checkPlatformAdmin } from '@/server/admin/require-platform-admin'

export async function GET(request: NextRequest) {
  const { userId, platformAdmin } = await checkPlatformAdmin(request)
  return NextResponse.json({ userId, platformAdmin })
}
