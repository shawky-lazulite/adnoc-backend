import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'
import 'dotenv/config'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Backend URL for generating page URLs
const BACKEND_URL = process.env.BACKEND_URL || 'https://adnoc-backend.vercel.app'

// Logo URL in Supabase (will be uploaded there)
const LOGO_URL = process.env.LOGO_URL || ''

const app = express()

// Middleware
app.use(cors())
app.use(express.json({ limit: '50mb' })) // Large limit for base64 images
app.use(express.static(path.join(__dirname, '..', 'public')))

// API Key for securing endpoints
const API_KEY = process.env.API_KEY || ''

/**
 * Middleware to validate API key
 */
function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Missing or invalid Authorization header',
    })
  }

  const providedKey = authHeader.substring(7) // Remove 'Bearer ' prefix
  
  if (!API_KEY) {
    console.error('[Auth] API_KEY environment variable is not set!')
    return res.status(500).json({
      success: false,
      error: 'Server configuration error',
    })
  }

  if (providedKey !== API_KEY) {
    return res.status(403).json({
      success: false,
      error: 'Invalid API key',
    })
  }

  next()
}

// Provider switch - set to 'atlascloud' or 'nanobanana'
const IMAGE_PROVIDER = process.env.IMAGE_PROVIDER || 'nanobanana'

// NanoBanana API configuration
const NANOBANANA_API_URL = 'https://api.nanobananaapi.ai/api/v1/nanobanana'

// AtlasCloud API configuration
const ATLASCLOUD_API_URL = 'https://api.atlascloud.ai/api/v1/model'
const ATLASCLOUD_DEFAULT_SIZE = '2048*2048'

// Shared polling configuration
const POLL_INTERVAL = 3000 // 3 seconds
const MAX_POLL_ATTEMPTS = 40 // ~2 minutes max

// Supabase client for image uploads
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)
const IMAGE_BUCKET = 'photobooth-images'

// ============================================
// NanoBanana Image Generation
// ============================================

interface GenerateRequest {
  image: string
  prompt: string
  imageSize?: string
}

interface GenerateTextRequest {
  prompt: string
  imageSize?: string
}

interface NanoBananaGenerateResponse {
  code: number
  msg: string
  data?: {
    taskId: string
  }
}

interface NanoBananaTaskResponse {
  code: number
  msg: string
  data?: {
    taskId: string
    successFlag: 0 | 1 | 2 | 3  // 0: GENERATING, 1: SUCCESS, 2: CREATE_TASK_FAILED, 3: GENERATE_FAILED
    response?: {
      originImageUrl?: string
      resultImageUrl?: string
    }
    errorCode?: number
    errorMessage?: string
  }
}

// ============================================
// AtlasCloud Image Generation
// ============================================

interface AtlasCloudGenerateResponse {
  data: {
    id: string
  }
}

interface AtlasCloudPollResponse {
  data: {
    status: 'completed' | 'failed' | 'processing'
    outputs?: string[]
    error?: string
  }
}

/**
 * Start image generation with AtlasCloud API
 */
async function startAtlasGeneration(
  imageUrl: string,
  prompt: string
): Promise<{ success: boolean; predictionId?: string; error?: string }> {
  try {
    const apiKey = process.env.ATLAS_CLOUD_API_KEY
    
    // Debug: Check if API key is loaded
    console.log('[Generate API] AtlasCloud API key present:', !!apiKey)
    console.log('[Generate API] AtlasCloud API key length:', apiKey?.length || 0)
    
    if (!apiKey) {
      return { success: false, error: 'ATLAS_CLOUD_API_KEY environment variable not set' }
    }
    
    const requestBody = {
      model: 'bytedance/seedream-v4.5/edit',
      enable_base64_output: false,
      images: [imageUrl],
      prompt,
      size: ATLASCLOUD_DEFAULT_SIZE,
    }
    
    console.log('[Generate API] AtlasCloud request URL:', `${ATLASCLOUD_API_URL}/generateImage`)
    console.log('[Generate API] AtlasCloud image URL:', imageUrl)
    console.log('[Generate API] AtlasCloud prompt length:', prompt.length)
    
    const response = await fetch(`${ATLASCLOUD_API_URL}/generateImage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    })
    
    console.log('[Generate API] AtlasCloud HTTP status:', response.status)

    const data = await response.json()
    console.log('[Generate API] AtlasCloud response:', JSON.stringify(data, null, 2))

    // Handle error response format: { code: number, msg: string }
    if (data.code && data.code !== 200) {
      return { success: false, error: `AtlasCloud error: ${data.msg || data.code}` }
    }

    // Handle success response format: { data: { id: string } }
    if (data.data?.id) {
      return { success: true, predictionId: data.data.id }
    }

    return { success: false, error: `Unexpected AtlasCloud response: ${JSON.stringify(data)}` }
  } catch (error) {
    console.error('[Generate API] AtlasCloud start error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Poll AtlasCloud for task completion
 */
async function pollAtlasResult(
  predictionId: string
): Promise<{ success: boolean; imageUrl?: string; error?: string }> {
  let attempts = 0

  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++
    console.log(`[Generate API] AtlasCloud polling attempt ${attempts}/${MAX_POLL_ATTEMPTS}`)

    try {
      const response = await fetch(`${ATLASCLOUD_API_URL}/prediction/${predictionId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.ATLAS_CLOUD_API_KEY}`,
        },
      })

      const data: AtlasCloudPollResponse = await response.json()
      console.log('[Generate API] AtlasCloud task status:', data)

      if (data.data) {
        const { status, outputs, error: taskError } = data.data

        if (status === 'completed' && outputs && outputs.length > 0) {
          return { success: true, imageUrl: outputs[0] }
        }

        if (status === 'failed') {
          return { success: false, error: taskError || 'AtlasCloud generation failed' }
        }

        // Still processing, wait and poll again
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
      } else {
        // Unexpected response, wait and retry
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
      }
    } catch (error) {
      console.error('[Generate API] AtlasCloud poll error:', error)
      // Continue polling on network errors
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
    }
  }

  return { success: false, error: 'AtlasCloud generation timed out' }
}

/**
 * Upload a base64 image to Supabase and get a public URL
 */
async function uploadBase64Image(base64Data: string): Promise<string | null> {
  try {
    // Remove the data URL prefix if present
    const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '')

    // Convert base64 to Buffer
    const buffer = Buffer.from(base64Content, 'base64')

    // Generate unique filename
    const filename = `capture_${Date.now()}.jpg`

    // Upload to Supabase
    const { data, error } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(filename, buffer, {
        contentType: 'image/jpeg',
        upsert: true,
      })

    if (error) {
      console.error('[Generate API] Upload error:', error)
      return null
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(IMAGE_BUCKET)
      .getPublicUrl(data.path)

    console.log('[Generate API] Image uploaded:', urlData.publicUrl)
    return urlData.publicUrl
  } catch (error) {
    console.error('[Generate API] Upload failed:', error)
    return null
  }
}

// ============================================
// Image Branding & Photo Storage
// ============================================

/**
 * Download an image from URL and return as Buffer
 */
async function downloadImage(imageUrl: string): Promise<Buffer> {
  const response = await fetch(imageUrl)
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/**
 * Composite logo onto an image (top-left corner)
 */
async function compositeLogoOnImage(imageUrl: string): Promise<Buffer> {
  console.log('[Branding] Compositing logo onto image...')
  
  // Download the generated image
  const imageBuffer = await downloadImage(imageUrl)
  
  // Download the logo
  if (!LOGO_URL) {
    console.warn('[Branding] No LOGO_URL configured, returning original image')
    return imageBuffer
  }
  
  const logoBuffer = await downloadImage(LOGO_URL)
  
  // Get image dimensions
  const imageMetadata = await sharp(imageBuffer).metadata()
  const imageWidth = imageMetadata.width || 2048
  
  // Resize logo to be proportional (e.g., 15% of image width)
  const logoWidth = Math.round(imageWidth * 0.15)
  const resizedLogo = await sharp(logoBuffer)
    .resize(logoWidth)
    .toBuffer()
  
  // Composite logo onto image (top-left with padding)
  const padding = Math.round(imageWidth * 0.03) // 3% padding
  const result = await sharp(imageBuffer)
    .composite([
      {
        input: resizedLogo,
        top: padding,
        left: padding,
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer()
  
  console.log('[Branding] Logo composited successfully')
  return result
}

/**
 * Upload branded image to Supabase
 */
async function uploadBrandedImage(imageBuffer: Buffer): Promise<string | null> {
  try {
    const filename = `branded_${Date.now()}.jpg`
    
    const { data, error } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(filename, imageBuffer, {
        contentType: 'image/jpeg',
        upsert: true,
      })
    
    if (error) {
      console.error('[Branding] Upload error:', error)
      return null
    }
    
    const { data: urlData } = supabase.storage
      .from(IMAGE_BUCKET)
      .getPublicUrl(data.path)
    
    console.log('[Branding] Branded image uploaded:', urlData.publicUrl)
    return urlData.publicUrl
  } catch (error) {
    console.error('[Branding] Upload failed:', error)
    return null
  }
}

/**
 * Save photo record to Supabase
 */
async function savePhotoRecord(imageUrl: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('photos')
      .insert({
        image_url: imageUrl,
      })
      .select('id')
      .single()
    
    if (error) {
      console.error('[Photos] Save error:', error)
      return null
    }
    
    console.log('[Photos] Photo record saved:', data.id)
    return data.id
  } catch (error) {
    console.error('[Photos] Save failed:', error)
    return null
  }
}

/**
 * Get photo record from Supabase
 */
async function getPhotoRecord(photoId: string): Promise<{ id: string; image_url: string; created_at: string } | null> {
  try {
    const { data, error } = await supabase
      .from('photos')
      .select('*')
      .eq('id', photoId)
      .single()
    
    if (error) {
      console.error('[Photos] Get error:', error)
      return null
    }
    
    return data
  } catch (error) {
    console.error('[Photos] Get failed:', error)
    return null
  }
}

/**
 * Start image generation with NanoBanana API
 */
async function startGeneration(
  imageUrl: string,
  prompt: string,
  imageSize: string
): Promise<{ success: boolean; taskId?: string; error?: string }> {
  try {
    const response = await fetch(`${NANOBANANA_API_URL}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.NANOBANANA_API_KEY}`,
      },
      body: JSON.stringify({
        prompt,
        numImages: 1,
        type: 'IMAGETOIAMGE',
        imageUrls: [imageUrl],
        image_size: imageSize,
      }),
    })

    const data: NanoBananaGenerateResponse = await response.json()
    console.log('[Generate API] NanoBanana response:', data)

    if (data.code === 200 && data.data?.taskId) {
      return { success: true, taskId: data.data.taskId }
    }

    return { success: false, error: data.msg || 'Failed to start generation' }
  } catch (error) {
    console.error('[Generate API] Start generation error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Poll for task completion
 */
async function pollForResult(
  taskId: string
): Promise<{ success: boolean; imageUrl?: string; error?: string }> {
  let attempts = 0

  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++
    console.log(`[Generate API] Polling attempt ${attempts}/${MAX_POLL_ATTEMPTS}`)

    try {
      // Use the correct endpoint: /record-info with taskId as query param
      const response = await fetch(`${NANOBANANA_API_URL}/record-info?taskId=${taskId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.NANOBANANA_API_KEY}`,
        },
      })

      const data: NanoBananaTaskResponse = await response.json()
      console.log('[Generate API] Task status:', data)

      if (data.code === 200 && data.data) {
        const { successFlag, response: taskResponse, errorMessage } = data.data

        // successFlag: 0 = GENERATING, 1 = SUCCESS, 2 = CREATE_TASK_FAILED, 3 = GENERATE_FAILED
        if (successFlag === 1 && taskResponse?.resultImageUrl) {
          return { success: true, imageUrl: taskResponse.resultImageUrl }
        }

        if (successFlag === 2 || successFlag === 3) {
          return { success: false, error: errorMessage || 'Image generation failed' }
        }

        // successFlag === 0 means still generating, wait and poll again
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
      } else if (data.code === 400) {
        return { success: false, error: data.msg || 'Content policy violation' }
      } else if (data.code === 404) {
        // Task not found yet, wait and retry
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
      } else if (data.code === 500 || data.code === 501) {
        return { success: false, error: data.msg || 'Server error' }
      } else {
        // Unknown status, wait and retry
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
      }
    } catch (error) {
      console.error('[Generate API] Poll error:', error)
      // Continue polling on network errors
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
    }
  }

  return { success: false, error: 'Generation timed out' }
}

/**
 * Start text-only image generation with AtlasCloud API (no source image)
 */
async function startAtlasTextGeneration(
  prompt: string
): Promise<{ success: boolean; predictionId?: string; error?: string }> {
  try {
    const apiKey = process.env.ATLAS_CLOUD_API_KEY

    console.log('[Generate Text API] AtlasCloud API key present:', !!apiKey)

    if (!apiKey) {
      return { success: false, error: 'ATLAS_CLOUD_API_KEY environment variable not set' }
    }

    const requestBody = {
      model: 'google/nano-banana/text-to-image',
      aspect_ratio: '16:9',
      prompt,
      enable_base64_output: false,
      enable_sync_mode: false,
      output_format: 'png',
    }

    console.log('[Generate Text API] AtlasCloud request URL:', `${ATLASCLOUD_API_URL}/generateImage`)
    console.log('[Generate Text API] AtlasCloud prompt length:', prompt.length)

    const response = await fetch(`${ATLASCLOUD_API_URL}/generateImage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    })

    console.log('[Generate Text API] AtlasCloud HTTP status:', response.status)

    const data = await response.json()
    console.log('[Generate Text API] AtlasCloud response:', JSON.stringify(data, null, 2))

    if (data.code && data.code !== 200) {
      return { success: false, error: `AtlasCloud error: ${data.msg || data.code}` }
    }

    if (data.data?.id) {
      return { success: true, predictionId: data.data.id }
    }

    return { success: false, error: `Unexpected AtlasCloud response: ${JSON.stringify(data)}` }
  } catch (error) {
    console.error('[Generate Text API] AtlasCloud start error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Start text-only generation with NanoBanana API (no source image)
 */
async function startTextGeneration(
  prompt: string,
  imageSize: string
): Promise<{ success: boolean; taskId?: string; error?: string }> {
  try {
    const response = await fetch(`${NANOBANANA_API_URL}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.NANOBANANA_API_KEY}`,
      },
      body: JSON.stringify({
        prompt,
        numImages: 1,
        type: 'TEXTTOIMAGE',
        image_size: imageSize,
      }),
    })

    const data: NanoBananaGenerateResponse = await response.json()
    console.log('[Generate Text API] NanoBanana response:', data)

    if (data.code === 200 && data.data?.taskId) {
      return { success: true, taskId: data.data.taskId }
    }

    return { success: false, error: data.msg || 'Failed to start text generation' }
  } catch (error) {
    console.error('[Generate Text API] Start text generation error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * POST /api/generate-text
 * Generate an AI image from text prompt only (no source image required)
 * Requires API key authentication via Bearer token
 */
app.post('/api/generate-text', requireApiKey, async (req, res) => {
  try {
    const body: GenerateTextRequest = req.body
    const { prompt, imageSize = '1:1' } = body

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: prompt',
      })
    }

    console.log('[Generate Text API] Using google/nano-banana/text-to-image via AtlasCloud')
    console.log('[Generate Text API] Starting text-to-image generation with prompt:', prompt)

    // Text-to-image always uses AtlasCloud with the google/nano-banana model
    const startResult = await startAtlasTextGeneration(prompt)
    if (!startResult.success || !startResult.predictionId) {
      return res.status(500).json({
        success: false,
        error: startResult.error,
      })
    }
    console.log('[Generate Text API] AtlasCloud task started:', startResult.predictionId)
    const result = await pollAtlasResult(startResult.predictionId)

    if (result.success && result.imageUrl) {
      console.log('[Generate Text API] Generation complete:', result.imageUrl)

      let brandedImageUrl = result.imageUrl
      let pageUrl: string | null = null

      try {
        const brandedBuffer = await compositeLogoOnImage(result.imageUrl)
        const uploadedBrandedUrl = await uploadBrandedImage(brandedBuffer)

        if (uploadedBrandedUrl) {
          brandedImageUrl = uploadedBrandedUrl

          const photoId = await savePhotoRecord(brandedImageUrl)
          if (photoId) {
            pageUrl = `${BACKEND_URL}/photo/${photoId}`
            console.log('[Generate Text API] Page URL generated:', pageUrl)
          }
        }
      } catch (brandingError) {
        console.error('[Generate Text API] Branding failed, returning original:', brandingError)
      }

      return res.json({
        success: true,
        imageUrl: brandedImageUrl,
        pageUrl: pageUrl,
      })
    }

    return res.status(500).json({
      success: false,
      error: result.error || 'Generation failed',
    })
  } catch (error) {
    console.error('[Generate Text API] Error:', error)
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

/**
 * POST /api/generate
 * Generate an AI image using the configured provider (NanoBanana or AtlasCloud)
 * Requires API key authentication via Bearer token
 */
app.post('/api/generate', requireApiKey, async (req, res) => {
  try {
    const body: GenerateRequest = req.body
    const { image, prompt, imageSize = '1:1' } = body

    if (!image || !prompt) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: image and prompt',
      })
    }

    console.log(`[Generate API] Using provider: ${IMAGE_PROVIDER}`)
    console.log('[Generate API] Starting generation with prompt:', prompt)

    // Step 1: Upload image if it's base64
    let imageUrl = image
    if (image.startsWith('data:')) {
      console.log('[Generate API] Uploading base64 image...')
      const uploadedUrl = await uploadBase64Image(image)
      if (!uploadedUrl) {
        return res.status(500).json({
          success: false,
          error: 'Failed to upload image',
        })
      }
      imageUrl = uploadedUrl
    }

    // Step 2 & 3: Generate based on provider
    let result: { success: boolean; imageUrl?: string; error?: string }

    if (IMAGE_PROVIDER === 'atlascloud') {
      // AtlasCloud flow
      const startResult = await startAtlasGeneration(imageUrl, prompt)
      if (!startResult.success || !startResult.predictionId) {
        return res.status(500).json({
          success: false,
          error: startResult.error,
        })
      }
      console.log('[Generate API] AtlasCloud task started:', startResult.predictionId)
      result = await pollAtlasResult(startResult.predictionId)
    } else {
      // NanoBanana flow (default)
      const startResult = await startGeneration(imageUrl, prompt, imageSize)
      if (!startResult.success || !startResult.taskId) {
        return res.status(500).json({
          success: false,
          error: startResult.error,
        })
      }
      console.log('[Generate API] NanoBanana task started:', startResult.taskId)
      result = await pollForResult(startResult.taskId)
    }

    if (result.success && result.imageUrl) {
      console.log('[Generate API] Generation complete:', result.imageUrl)
      
      // Step 4: Brand the image with logo
      let brandedImageUrl = result.imageUrl
      let pageUrl: string | null = null
      
      try {
        const brandedBuffer = await compositeLogoOnImage(result.imageUrl)
        const uploadedBrandedUrl = await uploadBrandedImage(brandedBuffer)
        
        if (uploadedBrandedUrl) {
          brandedImageUrl = uploadedBrandedUrl
          
          // Step 5: Save photo record and generate page URL
          const photoId = await savePhotoRecord(brandedImageUrl)
          if (photoId) {
            pageUrl = `${BACKEND_URL}/photo/${photoId}`
            console.log('[Generate API] Page URL generated:', pageUrl)
          }
        }
      } catch (brandingError) {
        console.error('[Generate API] Branding failed, returning original:', brandingError)
        // Continue with original image if branding fails
      }
      
      return res.json({
        success: true,
        imageUrl: brandedImageUrl,
        pageUrl: pageUrl,
      })
    }

    return res.status(500).json({
      success: false,
      error: result.error || 'Generation failed',
    })
  } catch (error) {
    console.error('[Generate API] Error:', error)
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

// ============================================
// Photo Landing Page
// ============================================

/**
 * GET /photo/:id
 * Serve the branded photo landing page for QR code scanning
 */
app.get('/photo/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    // Fetch photo record
    const photo = await getPhotoRecord(id)
    
    if (!photo) {
      return res.status(404).type('html').send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Photo Not Found</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: #31A6B0;
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              color: white;
              text-align: center;
              padding: 20px;
            }
            .logo { margin-bottom: 32px; }
            .logo img { height: 48px; width: auto; }
            h1 { font-size: 2rem; margin-bottom: 1rem; }
            p { opacity: 0.7; }
          </style>
        </head>
        <body>
          <div class="logo">
            <img src="${BACKEND_URL}/logo.png" alt="ADNOC Logo" />
          </div>
          <div>
            <h1>Photo Not Found</h1>
            <p>This photo may have been removed or the link is invalid.</p>
          </div>
        </body>
        </html>
      `)
    }
    
    const imageUrl = photo.image_url
    const pageUrl = `${BACKEND_URL}/photo/${id}`
    
    // Serve the landing page
    const logoUrl = `${BACKEND_URL}/logo.png`
    
    res.type('html').send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="og:image" content="${imageUrl}">
        <meta name="og:title" content="My ADNOC AI Photo">
        <meta name="og:description" content="Check out my AI-generated photo!">
        <title>My ADNOC AI Photo</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #31A6B0;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 20px;
            color: white;
          }
          .logo {
            margin-top: 12px;
            margin-bottom: 24px;
          }
          .logo img {
            height: 48px;
            width: auto;
          }
          .container {
            max-width: 600px;
            width: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 24px;
          }
          .image-container {
            width: 100%;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,0.25);
          }
          .image-container img {
            width: 100%;
            height: auto;
            display: block;
          }
          .buttons {
            display: flex;
            gap: 16px;
            width: 100%;
            justify-content: center;
            flex-wrap: wrap;
          }
          .btn {
            padding: 16px 32px;
            border: none;
            border-radius: 12px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: transform 0.2s, box-shadow 0.2s;
            text-decoration: none;
          }
          .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px rgba(0,0,0,0.3);
          }
          .btn-download {
            background: rgba(255,255,255,0.2);
            color: white;
            backdrop-filter: blur(8px);
            border: 1px solid rgba(255,255,255,0.3);
          }
          .btn-share {
            background: rgba(255,255,255,0.2);
            color: white;
            backdrop-filter: blur(8px);
            border: 1px solid rgba(255,255,255,0.3);
          }
          .btn svg {
            width: 20px;
            height: 20px;
            fill: currentColor;
          }
          .footer {
            margin-top: auto;
            padding-top: 40px;
            opacity: 0.7;
            font-size: 0.875rem;
            text-align: center;
          }
          .toast {
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.7);
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            opacity: 0;
            transition: opacity 0.3s;
            pointer-events: none;
          }
          .toast.show {
            opacity: 1;
          }
        </style>
      </head>
      <body>
        <div class="logo">
          <img src="${logoUrl}" alt="ADNOC Logo" />
        </div>

        <div class="container">
          <div class="image-container">
            <img src="${imageUrl}" alt="AI Generated Photo" />
          </div>
          
          <div class="buttons">
            <a href="${imageUrl}" download="my-ai-photo.jpg" class="btn btn-download">
              <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              Download
            </a>
            <button class="btn btn-share" onclick="sharePhoto()">
              <svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>
              Share
            </button>
          </div>
          
          <div class="footer">
            Powered by ADNOC AI Photo Booth
          </div>
        </div>
        
        <div class="toast" id="toast">Link copied to clipboard!</div>
        
        <script>
          async function sharePhoto() {
            const shareData = {
              title: 'My AI Photo',
              text: 'Check out my AI-generated photo!',
              url: '${pageUrl}'
            };
            
            if (navigator.share && navigator.canShare && navigator.canShare(shareData)) {
              try {
                await navigator.share(shareData);
              } catch (err) {
                if (err.name !== 'AbortError') {
                  copyToClipboard();
                }
              }
            } else {
              copyToClipboard();
            }
          }
          
          function copyToClipboard() {
            navigator.clipboard.writeText('${pageUrl}').then(() => {
              showToast();
            }).catch(() => {
              // Fallback for older browsers
              const input = document.createElement('input');
              input.value = '${pageUrl}';
              document.body.appendChild(input);
              input.select();
              document.execCommand('copy');
              document.body.removeChild(input);
              showToast();
            });
          }
          
          function showToast() {
            const toast = document.getElementById('toast');
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 2000);
          }
        </script>
      </body>
      </html>
    `)
  } catch (error) {
    console.error('[Photo Page] Error:', error)
    return res.status(500).type('html').send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Error</title>
        <style>
          body { 
            font-family: sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: #1a1a2e;
            color: white;
          }
        </style>
      </head>
      <body>
        <p>Something went wrong. Please try again later.</p>
      </body>
      </html>
    `)
  }
})

// ============================================
// Existing Routes
// ============================================

// Home route - HTML
app.get('/', (req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8"/>
        <title>ADNOC Backend API</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <nav>
          <a href="/">Home</a>
          <a href="/healthz">Health</a>
        </nav>
        <h1>ADNOC Backend API</h1>
        <p>AI Photo Booth backend service.</p>
        <h2>Endpoints:</h2>
        <ul>
          <li><code>POST /api/generate</code> - Generate AI image</li>
          <li><code>GET /healthz</code> - Health check</li>
        </ul>
      </body>
    </html>
  `)
})

app.get('/about', function (req, res) {
  res.sendFile(path.join(__dirname, '..', 'components', 'about.htm'))
})

// Health check
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() })
})

export default app
