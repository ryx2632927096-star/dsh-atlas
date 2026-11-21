
let cachedDefineTool = null
let defineToolState = 'unprobed'
let usesValueSchemaDsl = false

export function textOutputSchema() {
  if (usesValueSchemaDsl) {
    return { type: 'object', properties: { text: { type: 'string', required: true } }, additionalProperties: false }
  }
  return { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
}

export async function tryLoadDefineTool() {
  if (defineToolState === 'ok') return cachedDefineTool
  if (defineToolState === 'failed') return null
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod && typeof mod.defineTool === 'function') {
      cachedDefineTool = mod.defineTool
      usesValueSchemaDsl = typeof mod.valueSchemaSpecToJsonSchema === 'function'
      defineToolState = 'ok'
      return cachedDefineTool
    }
    defineToolState = 'failed'
    return null
  } catch {
    defineToolState = 'failed'
    return null
  }
}

export function compatState() {
  return defineToolState
}

export function manualDefineTool(options) {
  const { name, description, parameters, output, execute } = options || {}
  if (typeof name !== 'string' || !name) throw new Error('manualDefineTool: name 必填')
  if (typeof execute !== 'function') throw new Error('manualDefineTool: execute 必填')

  const properties = {}
  if (parameters && typeof parameters === 'object') {
    for (const [key, spec] of Object.entries(parameters)) {
      properties[key] = {
        type: spec?.type || 'string',
        ...(spec?.description ? { description: spec.description } : {}),
        ...(spec?.enum ? { enum: spec.enum } : {}),
      }
    }
  }

  return {
    name,
    description: description || '',
    parameters: { type: 'object', properties },
    output: {
      schema: output?.schema && output.schema.type ? output.schema
        : { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: typeof output?.render === 'function' ? output.render : () => [{ type: 'text', text: '' }],
    },
    execute: async (args) => execute(args, {}),
  }
}

export async function resolveDefineTool() {
  const official = await tryLoadDefineTool()
  return official || manualDefineTool
}
