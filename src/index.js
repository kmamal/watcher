const Fs = require('fs')
const Path = require('path')
const { EventEmitter } = require('events')
const { Matcher } = require('@kmamal/globs/matcher')
const { comm } = require('@kmamal/util/array/comm')

class Watcher extends EventEmitter {
	constructor (glob, options) {
		super()
		this._cwd = options?.cwd ? Path.resolve(options.cwd) : process.cwd()
		this._throttling = options?.throttling ?? 100

		this._matcher = new Matcher(glob, options)
		this._cache = new Map()
		this._scheduled = new Set()

		const addEntry = async (fsPath, props) => {
			if (this._cache.has(fsPath)) { return }
			const stats = props?.stats ?? await Fs.promises.stats()
			const isDir = props?.isDir ?? stats.isDirectory()
			const path = props?.path ?? (isDir ? `${fsPath}/` : fsPath)

			const watcher = Fs.watch(fsPath, (event, relPath) => {
				handleChange(isDir ? Path.join(fsPath, relPath) : fsPath)
			})

			let contents
			if (isDir) {
				contents = await Fs.promises.readdir(fsPath)
				contents.sort()
			}
			this._cache.set(fsPath, {
				watcher,
				ino: stats.ino,
				mtimeMs: stats.mtimeMs,
				contents,
			})

			const type = isDir ? 'addDir' : 'addFile'
			this.emit('change', type, path, stats)

			if (isDir && !props?.exhaustive) {
				const fileIterator = this._matcher.getFiles({
					cwd: fsPath,
					includeDirs: true,
				})
				for await (const entry of fileIterator) {
					const { path: childPath, stats: childStats } = entry
					const childIsDir = childStats.isDirectory()
					const childFsPath = childIsDir ? childPath.slice(0, -1) : childPath
					await addEntry(childFsPath, {
						stats: childStats,
						path: childPath,
						isDir: childIsDir,
						exhaustive: true,
					})
				}
			}
		}

		const removeEntry = (fsPath, props) => {
			const entry = props?.entry ?? this._cache.get(fsPath)
			if (!entry) { return }
			const isDir = props?.isDir ?? Boolean(entry.contents)
			const path = props?.isDir ?? (isDir ? `${fsPath}/` : fsPath)

			entry.watcher.close()
			this._cache.delete(fsPath)

			if (isDir && !props?.exhaustive) {
				for (const name of entry.contents) {
					removeEntry(Path.join(fsPath, name))
				}
			}

			const type = isDir ? 'delDir' : 'delFile'
			this.emit('change', type, path)
		}

		const handleChange = (fsPath) => {
			if (this._scheduled.has(fsPath)) { return }
			if (!this._matcher.matchesPath(fsPath)) { return }
			this._scheduled.add(fsPath)
			setTimeout(() => {
				this._scheduled.delete(fsPath)
				_handleChange(fsPath)
			}, this._throttling)
		}

		const _handleChange = async (fsPath) => {
			let entry = this._cache.get(fsPath)

			try {
				const newStats = await Fs.promises.stat(fsPath)
				const isDir = newStats.isDirectory()
				const newPath = isDir ? `${fsPath}/` : fsPath

				const wasDir = Boolean(entry?.contents)
				const oldPath = wasDir ? `${fsPath}/` : fsPath

				if (!entry || wasDir !== isDir || entry.ino !== newStats.ino) {
					if (entry) { removeEntry(fsPath, { entry, path: oldPath, isDir: wasDir }) }
					entry = addEntry(fsPath, { stats: newStats, path: newPath, isDir })
					return
				}

				if (entry.mtimeMs >= newStats.mtimeMs) { return }

				if (!isDir) {
					this.emit('change', 'change', newPath, newStats)
				} else {
					const newContents = await Fs.promises.readdir(fsPath)
					newContents.sort()

					const { a, b } = comm(entry.contents, newContents)
					for (const name of a) {
						removeEntry(Path.join(fsPath, name))
					}
					for (const name of b) {
						addEntry(Path.join(fsPath, name))
					}
				}
			} catch (error) {
				if (entry) { removeEntry(fsPath, { entry }) }
			}
		}

		;(async () => {
			const fileIterator = this._matcher.getFiles({ includeDirs: true })
			for await (const { path, stats } of fileIterator) {
				const isDir = stats.isDirectory()
				const fsPath = isDir ? path.slice(0, -1) : path
				await addEntry(fsPath, { stats, path, isDir, exhaustive: true })
			}
		})()
	}
}

module.exports = { Watcher }
