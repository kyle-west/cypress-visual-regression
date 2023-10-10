import { createWriteStream, promises as fs } from 'fs'
import path from 'path'
import pixelMatch from 'pixelmatch'
import { PNG } from 'pngjs'
import sanitize from 'sanitize-filename'
import { serializeError, type ErrorObject } from 'serialize-error'

import { createFolder } from './utils/fs'
import { adjustCanvas, parseImage } from './utils/image'
import { logger } from './logger'

export type UpdateSnapshotOptions = {
  screenshotName: string
  specName: string
  screenshotAbsolutePath: string
  baseDirectory?: string
}

export type CompareSnapshotsOptions = {
  screenshotName: string
  errorThreshold: number
  specName: string
  screenshotAbsolutePath: string
  baseDirectory?: string
  diffDirectory?: string
  generateDiff?: 'always' | 'fail' | 'never'
}

export type CompareSnapshotResult = {
  error?: ErrorObject
  mismatchedPixels?: number
  percentage?: number
}

/** Update the base snapshot .png by copying the generated snapshot to the base snapshot directory.
 * The target path is constructed from parts at runtime in node to be OS independent.  */
const updateSnapshot = async (options: UpdateSnapshotOptions): Promise<boolean> => {
  const toDir = options.baseDirectory ?? path.join(process.cwd(), 'cypress', 'snapshots', 'base')
  const destDir = path.join(toDir, options.specName)
  const destFile = path.join(destDir, `${options.screenshotName}.png`)

  await createFolder(destDir)
  await fs.copyFile(options.screenshotAbsolutePath, destFile)
  logger.debug(`Updated base snapshot '${options.screenshotName}' at ${destFile}`)
  return true
}

/** Cypress plugin to compare image snapshots & generate a diff image.
 *
 * Uses the pixelmatch library internally.
 */
const compareSnapshots = async (options: CompareSnapshotsOptions): Promise<CompareSnapshotResult> => {
  const snapshotBaseDirectory = options.baseDirectory ?? path.join(process.cwd(), 'cypress', 'snapshots', 'base')
  const snapshotDiffDirectory = options.diffDirectory ?? path.join(process.cwd(), 'cypress', 'snapshots', 'diff')

  const fileName = sanitize(options.screenshotName)

  const actualImage = options.screenshotAbsolutePath
  const expectedImage = path.join(snapshotBaseDirectory, options.specName, `${fileName}.png`)
  const diffImage = path.join(snapshotDiffDirectory, options.specName, `${fileName}.png`)

  await createFolder(snapshotDiffDirectory)
  const [imgExpected, imgActual] = await Promise.all([parseImage(expectedImage), parseImage(actualImage)])
  const diff = new PNG({
    width: Math.max(imgActual.width, imgExpected.width),
    height: Math.max(imgActual.height, imgExpected.height)
  })

  const imgActualFullCanvas = adjustCanvas(imgActual, diff.width, diff.height)
  const imgExpectedFullCanvas = adjustCanvas(imgExpected, diff.width, diff.height)

  const mismatchedPixels = pixelMatch(
    imgActualFullCanvas.data,
    imgExpectedFullCanvas.data,
    diff.data,
    diff.width,
    diff.height,
    { threshold: 0.1 }
  )
  const percentage = (mismatchedPixels / diff.width / diff.height) ** 0.5

  if (percentage > options.errorThreshold) {
    logger.error(`Error in visual regression found: ${percentage.toFixed(2)}`)
    if (options.generateDiff !== 'never') {
      const specFolder = path.join(snapshotDiffDirectory, options.specName)
      await createFolder(specFolder)
      diff.pack().pipe(createWriteStream(diffImage))
      logger.debug(`Image with pixel difference generated: ${diffImage}`)
    }
    return {
      error: serializeError(
        new Error(
          `The "${fileName}" image is different. Threshold limit exceeded!
          Expected: ${options.errorThreshold}
          Actual: ${percentage}`
        )
      ),
      mismatchedPixels,
      percentage
    }
  } else if (options.generateDiff === 'always') {
    const specFolder = path.join(snapshotDiffDirectory, options.specName)
    await createFolder(specFolder)
    diff.pack().pipe(createWriteStream(diffImage))
    logger.debug(`Image with pixel difference generated: ${diffImage}`)
  }
  return {
    mismatchedPixels,
    percentage
  }
}

/** Configure the plugin to compare snapshots. */
const configureVisualRegression = (on: Cypress.PluginEvents): void => {
  on('task', {
    compareSnapshots,
    updateSnapshot
  })
}

export default configureVisualRegression
