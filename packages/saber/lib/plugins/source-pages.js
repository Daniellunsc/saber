const path = require('path')
const { fs, glob } = require('saber-utils')
const chokidar = require('chokidar')
const { log } = require('saber-log')
const hash = require('hash-sum')

const ID = 'builtin:source-pages'

exports.name = ID

exports.apply = api => {
  api.hooks.beforeRun.tapPromise(ID, async ({ watch }) => {
    const pagesDir = api.resolveCwd('pages')
    const exts = api.transformers.supportedExtensions
    const filePatterns = [
      `**/*.${exts.length === 1 ? exts[0] : `{${exts.join(',')}}`}`,
      '!**/{node_modules,dist,vendor}/**',
      '!**/_!(posts)/**'
    ]

    const files = await glob(filePatterns, {
      cwd: pagesDir,
      dot: false,
      stats: true
    }).then(files =>
      Promise.all(
        files
          .sort((a, b) => (a.path > b.path ? 1 : -1))
          .map(async file => {
            file.relative = file.path
            file.absolute = path.join(pagesDir, file.relative)
            file.content = await fs.readFile(file.absolute, 'utf8')
            log.debug(`Found page`, file.absolute)
            return file
          })
      )
    )

    api.hooks.createPage.tap('create-page', page => {
      api.pages.createPage(page)
      api.hooks.onCreatePage.call(page)
    })

    api.hooks.manipulatePage.tap('manipulate-page', ({ action, id, page }) => {
      // Remove all child pages
      api.pages.removeWhere(page => page.internal.parent)

      if (action === 'remove') {
        // Remove itself
        api.pages.removeWhere(page => {
          return page.internal.id === id
        })
      } else if (action) {
        api.hooks.createPage.call(page)
      }
    })

    // Write all pages
    // This is triggered by all file actions: change, add, remove
    api.hooks.emitPages.tapPromise('pages', async () => {
      const pages = [...api.pages.values()]
      log.debug('Emitting pages')
      // TODO: maybe write pages with limited concurrency?
      await Promise.all(
        pages.map(async page => {
          if (page.internal.saved) return

          const newContent = JSON.stringify({
            page,
            prop: api.pages.pageProps.get(page.internal.id)
          })
          const outPath = api.resolveCache(
            'pages',
            `${page.internal.id}.saberpage`
          )
          // TODO: is there any better solution to checking if we need to write the page?
          const exists = await fs.pathExists(outPath)
          if (exists) {
            const content = await fs.readFile(outPath, 'utf8')
            if (content === newContent) {
              // Skip if content doesn't change
              return
            }
          }
          log.debug(`Emitting page ${outPath}`)
          await fs.outputFile(outPath, newContent, 'utf8')
          page.internal.saved = true
        })
      )
    })

    await api.hooks.initPages.promise()

    for (const file of files) {
      const page = api.pages.parseFile(file)
      api.hooks.createPage.call(page)
    }

    await api.hooks.onCreatePages.promise()
    await api.hooks.emitPages.promise()

    if (watch) {
      const watcher = chokidar.watch(filePatterns, {
        cwd: pagesDir,
        ignoreInitial: true
      })
      const handler = type => async filename => {
        const filepath = path.join(pagesDir, filename)

        if (type === 'remove') {
          api.hooks.manipulatePage.call({
            action: 'remove',
            id: hash(filepath)
          })
        } else {
          const file = await fs.stat(filepath)
          file.relative = filename
          file.absolute = filepath
          file.content = await fs.readFile(file.absolute, 'utf8')
          const page = api.pages.parseFile(file)
          api.hooks.manipulatePage.call({ action: 'create', page })
        }

        await api.hooks.onCreatePages.promise()
        await api.hooks.emitPages.promise()
        await api.hooks.emitRoutes.promise()
      }
      watcher.on('add', handler('add'))
      watcher.on('unlink', handler('remove'))
      watcher.on('change', handler('change'))
    }
  })
}
