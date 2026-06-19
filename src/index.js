const Fs = require('node:fs')
const Path = require('node:path')
const { EventEmitter } = require('node:events')

const { Matcher } = require('@kmamal/globs/matcher')
const { comm } = require('@kmamal/util/array/comm')
const { AbortableOpener } = require('@kmamal/async/opener')

class Watcher extends EventEmitter {
	constructor () {
		super()
		this._cwd = null
		this._throttling = null

		this._matcher = null
		this._entries = new Map()
		this._scheduled = new Map()
		this._running = new Map()

		this._opener = new AbortableOpener()
		this._ac = null
	}

	async open (glob, options) {
		return await this._opener.open(async (ac) => {
			this._ac = ac

			this._cwd = options?.cwd ? Path.resolve(options.cwd) : process.cwd()
			this._throttling = options?.throttling ?? 100

			this._matcher = new Matcher(glob, options)

			const fileIterator = this._matcher.getFiles({ includeDirs: true })
			for await (const { path, stats } of fileIterator) {
				if (ac.signal.aborted) { break }

				const isDir = stats.isDirectory()
				const fsPath = isDir ? path.slice(0, -1) : path
				await this._addEntry(fsPath, { stats, path, isDir, exhaustive: true }, ac.signal)

				if (ac.signal.aborted) { break }
			}
		})
	}

	async close () {
		return await this._opener.close(() => {
			this._ac.abort()
			this._ac = null

			for (const entry of this._entries.values()) { entry.watcher.close() }
			for (const timeout of this._scheduled.values()) { clearTimeout(timeout) }

			this._cwd = null
			this._throttling = null

			this._matcher = null
			this._entries.clear()
			this._scheduled.clear()
			this._running.clear()
		})
	}

	async _addEntry (fsPath, props, signal) {
		const prev = this._running.get(fsPath) ?? Promise.resolve()
		const next = prev
			.then(() => signal.aborted ? undefined : this._doAddEntry(fsPath, props, signal))
			.finally(() => {
				if (this._running.get(fsPath) === next) { this._running.delete(fsPath) }
			})
		this._running.set(fsPath, next)
		await next
	}

	async _doAddEntry (fsPath, props, signal) {
		if (this._entries.has(fsPath)) { return }
		const stats = props?.stats ?? await Fs.promises.stat(fsPath)
		const isDir = props?.isDir ?? stats.isDirectory()
		const path = props?.path ?? (isDir ? `${fsPath}/` : fsPath)

		if (signal.aborted) { return }

		let contents
		if (isDir) {
			contents = await Fs.promises.readdir(fsPath)
			if (signal.aborted) { return }
			contents.sort()
		}

		const watcher = Fs.watch(fsPath, (event, relPath) => {
			if (!relPath) {
				console.warn(`Watcher: ${event} event on ${fsPath} with no relPath`)
				return
			}
			this._handleChange(isDir ? Path.join(fsPath, relPath) : fsPath, signal)
		})

		this._entries.set(fsPath, {
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
				if (signal.aborted) { return }

				const { path: childPath, stats: childStats } = entry
				const childIsDir = childStats.isDirectory()
				const childFsPath = childIsDir ? childPath.slice(0, -1) : childPath

				await this._addEntry(childFsPath, {
					stats: childStats,
					path: childPath,
					isDir: childIsDir,
					exhaustive: true,
				}, signal)
				if (signal.aborted) { return }
			}
		}
	}

	_removeEntry (fsPath, props, signal) {
		const entry = props?.entry ?? this._entries.get(fsPath)
		if (!entry) { return }
		const isDir = props?.isDir ?? Boolean(entry.contents)
		const path = props?.path ?? (isDir ? `${fsPath}/` : fsPath)

		entry.watcher.close()
		this._entries.delete(fsPath)

		if (isDir && !props?.exhaustive) {
			for (const name of entry.contents) {
				this._removeEntry(Path.join(fsPath, name), undefined, signal)
			}
		}

		const type = isDir ? 'delDir' : 'delFile'
		this.emit('change', type, path)
	}

	_handleChange (fsPath, signal) {
		if (signal.aborted) { return }

		if (this._scheduled.has(fsPath)) { return }
		if (!this._matcher.matchesPath(fsPath)) { return }

		this._scheduled.set(fsPath, setTimeout(() => {
			this._scheduled.delete(fsPath)

			const prev = this._running.get(fsPath) ?? Promise.resolve()
			const next = prev
				.then(() => signal.aborted ? undefined : this._doHandleChange(fsPath, signal))
				.finally(() => {
					if (this._running.get(fsPath) === next) { this._running.delete(fsPath) }
				})
			this._running.set(fsPath, next)
		}, this._throttling))
	}

	async _doHandleChange (fsPath, signal) {
		if (signal.aborted) { return }
		const entry = this._entries.get(fsPath)

		try {
			const newStats = await Fs.promises.stat(fsPath)
			if (signal.aborted) { return }

			const isDir = newStats.isDirectory()
			const newPath = isDir ? `${fsPath}/` : fsPath

			const wasDir = Boolean(entry?.contents)
			const oldPath = wasDir ? `${fsPath}/` : fsPath

			if (!entry || wasDir !== isDir || entry.ino !== newStats.ino) {
				if (entry) { this._removeEntry(fsPath, { entry, path: oldPath, isDir: wasDir }, signal) }
				await this._doAddEntry(fsPath, { stats: newStats, path: newPath, isDir }, signal)
				return
			}

			if (entry.mtimeMs >= newStats.mtimeMs) { return }
			entry.mtimeMs = newStats.mtimeMs

			if (!isDir) {
				this.emit('change', 'change', newPath, newStats)
			}
			else {
				const newContents = await Fs.promises.readdir(fsPath)
				if (signal.aborted) { return }

				newContents.sort()

				const { a, b } = comm(entry.contents, newContents)
				for (const name of a) {
					this._removeEntry(Path.join(fsPath, name), undefined, signal)
				}
				for (const name of b) {
					await this._addEntry(Path.join(fsPath, name), undefined, signal)
					if (signal.aborted) { return }
				}

				entry.contents = newContents
			}
		}
		catch (error) {
			if (error.code !== 'ENOENT') { throw error }
			if (entry) { this._removeEntry(fsPath, { entry }, signal) }
		}
	}
}

module.exports = { Watcher }
