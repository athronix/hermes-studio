import type { Context } from 'koa'
import { config } from '../config'
import { createMcuDevice, deleteMcuDevice, listMcuDevices, updateMcuDeviceName } from '../db/hermes/mcu-devices-store'

function normalizeDeviceCode(value: unknown): string {
  const normalized = String(value || '').trim()
  return normalized.length <= 255 ? normalized : ''
}

function normalizeName(value: unknown, deviceCode: string): string {
  const normalized = String(value || '').trim()
  if (normalized.length > 80) return normalized.slice(0, 80)
  return normalized || deviceCode
}

async function verifyOfficialDeviceCode(deviceCode: string): Promise<boolean> {
  try {
    const url = `${config.remoteRelay.url.replace(/\/$/, '')}/global-agent/device/${encodeURIComponent(deviceCode)}`
    const response = await fetch(url, { method: 'GET' })
    return response.ok
  } catch {
    return false
  }
}

export async function listMcuDevicesController(ctx: Context) {
  ctx.body = { devices: listMcuDevices() }
}

export async function createMcuDeviceController(ctx: Context) {
  const body = ctx.request.body as { name?: unknown; device_code?: unknown; deviceCode?: unknown } | undefined
  const deviceCode = normalizeDeviceCode(body?.device_code ?? body?.deviceCode)
  if (!deviceCode) {
    ctx.status = 400
    ctx.body = { error: 'device_code is required' }
    return
  }

  const isOfficial = await verifyOfficialDeviceCode(deviceCode)

  try {
    const device = createMcuDevice({
      name: normalizeName(body?.name, deviceCode),
      deviceCode,
      isOfficial,
    })
    ctx.status = 201
    ctx.body = {
      device,
      devices: listMcuDevices(),
    }
  } catch (error: any) {
    if (error?.message === 'mcu_device_exists') {
      ctx.status = 409
      ctx.body = { error: 'MCU device already exists' }
      return
    }
    throw error
  }
}

export async function updateMcuDeviceController(ctx: Context) {
  const id = Number(ctx.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    ctx.status = 400
    ctx.body = { error: 'invalid mcu device id' }
    return
  }

  const body = ctx.request.body as { name?: unknown } | undefined
  try {
    const device = updateMcuDeviceName(id, String(body?.name || ''))
    ctx.body = {
      device,
      devices: listMcuDevices(),
    }
  } catch (error: any) {
    if (error?.message === 'mcu_device_not_found') {
      ctx.status = 404
      ctx.body = { error: 'MCU device not found' }
      return
    }
    throw error
  }
}

export async function deleteMcuDeviceController(ctx: Context) {
  const id = Number(ctx.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    ctx.status = 400
    ctx.body = { error: 'invalid mcu device id' }
    return
  }

  const deleted = deleteMcuDevice(id)
  if (!deleted) {
    ctx.status = 404
    ctx.body = { error: 'MCU device not found' }
    return
  }

  ctx.body = { devices: listMcuDevices() }
}
