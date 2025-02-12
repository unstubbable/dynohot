import type { BindingEntry, ExportIndirectEntry, ExportIndirectStarEntry, ExportStarEntry } from "./binding.js";
import type { LoadedModuleRequestEntry, ModuleBody, ModuleDeclaration } from "./declaration.js";
import type { AbstractModuleController, ModuleNamespace } from "./module.js";
import type { Format } from "dynohot/node-loader";
import * as assert from "node:assert/strict";
import Fn from "dynohot/functional";
import { BindingType } from "./binding.js";
import { dispose, isAccepted, isAcceptedSelf, isDeclined, isInvalidated, prune, tryAccept, tryAcceptSelf } from "./hot.js";
import { ReloadableModuleInstance } from "./instance.js";
import { ModuleStatus } from "./module.js";
import { makeAcquireVisitIndex, makeTraversalState, traverseDepthFirst } from "./traverse.js";
import { debounceAsync, debounceTimer, discriminatedTypePredicate, evictModule, iterateWithRollback, makeRelative, plural } from "./utility.js";
import { FileWatcher } from "./watcher.js";

/** @internal */
export function makeAcquire(dynamicImport: DynamicImport) {
	const application: Application = {
		dynamicImport,
		requestUpdate: defaultRequestUpdate,
		requestUpdateResult: defaultRequestUpdateResult,
	};
	const modules = new Map<string, ReloadableModuleController>();
	return function acquire(url: string) {
		return modules.get(url) ?? function() {
			const module = new ReloadableModuleController(application, url);
			modules.set(url, module);
			return module;
		}();
	};
}

function defaultRequestUpdate() {
	console.error("[hot] Update requested before fully loaded.");
	return Promise.resolve();
}

// eslint-disable-next-line @typescript-eslint/require-await
async function defaultRequestUpdateResult(): Promise<never> {
	throw new Error("Not fully loaded.");
}

interface Application {
	dynamicImport: DynamicImport;
	requestUpdate: () => Promise<void>;
	requestUpdateResult: () => Promise<UpdateResult>;
}

type DynamicImport = (specifier: string, importAssertions?: Record<string, string>) => Promise<ModuleNamespace>;

/** @internal */
export enum UpdateStatus {
	success = "success",
	declined = "declined",
	evaluationFailure = "evaluationError",
	linkError = "linkError",
	fatalError = "fatalError",
	unaccepted = "unaccepted",
	unacceptedEvaluation = "unacceptedEvaluation",
}

type UpdateResult =
	undefined |
	UpdateSuccess |
	UpdateDeclined |
	UpdateUnaccepted |
	UpdateEvaluationError |
	UpdateFatalError |
	UpdateLinkError;

interface UpdateSuccess {
	type: UpdateStatus.success | UpdateStatus.unacceptedEvaluation;
	stats: () => UpdateStats;
}

interface UpdateDeclined {
	type: UpdateStatus.declined;
	declined: readonly ReloadableModuleController[];
}

interface UpdateUnaccepted {
	type: UpdateStatus.unaccepted;
	chain: readonly InvalidationChain[];
}

interface UpdateEvaluationError {
	type: UpdateStatus.evaluationFailure;
	error: unknown;
	stats: () => UpdateStats;
}

interface UpdateLinkError {
	type: UpdateStatus.linkError;
	error: unknown;
}

interface UpdateFatalError {
	type: UpdateStatus.fatalError;
	error: unknown;
}

interface UpdateStats {
	duration: number;
	loads: number;
	reevaluations: number;
}

interface InvalidationChain {
	modules: readonly ReloadableModuleController[];
	/** `undefined` means it's the end of the chain, `null` means we've seen this branch before */
	next: readonly InvalidationChain[] | undefined | null;
}

function logUpdate(update: UpdateResult) {
	if (update === undefined) {
		return;
	}
	switch (update.type) {
		case UpdateStatus.declined:
			console.error(`[hot] A pending update was explicitly declined:\n${update.declined.map(module => `- ${makeRelative(module.url)}`).join("\n")}`);
			break;

		case UpdateStatus.fatalError:
			console.error("[hot] A fatal error was encountered. The application should be restarted!");
			break;

		case UpdateStatus.evaluationFailure: {
			const { duration, loads, reevaluations } = update.stats();
			const ms = Math.round(duration);
			console.error(`[hot] Loaded ${loads} new ${plural("module", loads)}, reevaluated ${reevaluations} existing ${plural("module", reevaluations)} in ${ms}ms.`);
			console.error("[hot] Caught evaluation error:", update.error);
			break;
		}

		case UpdateStatus.linkError: {
			const { error } = update;
			console.error("[hot] Caught link error:");
			if (error instanceof SyntaxError && "url" in error) {
				console.error(`${error.name}: ${error.message}\n    at (${String(error.url)})`);
			} else {
				console.error(error);
			}
			break;
		}

		case UpdateStatus.success: {
			const { duration, loads, reevaluations } = update.stats();
			const ms = Math.round(duration);
			console.error(`[hot] Loaded ${loads} new ${plural("module", loads)}, reevaluated ${reevaluations} existing ${plural("module", reevaluations)} in ${ms}ms.`);
			break;
		}

		case UpdateStatus.unaccepted: {
			// Nice:
			// https://stackoverflow.com/questions/4965335/how-to-print-binary-tree-diagram-in-java/8948691#8948691
			const logChain = (chain: InvalidationChain, prefix = "", childrenPrefix = "") => {
				const suffix = chain.next === undefined ? " 🔄" : "";
				console.error(`  ${prefix}[${chain.modules.map(module => makeRelative(module.url)).join(", ")}]${suffix}`);
				if (chain.next === null) {
					console.error(`  ${childrenPrefix}[...]`);
				} else if (chain.next !== undefined) {
					for (const [ ii, child ] of chain.next.entries()) {
						if (ii === chain.next.length - 1) {
							logChain(child, `${childrenPrefix}└─ `, `${childrenPrefix}   `);
						} else {
							logChain(child, `${childrenPrefix}├─ `, `${childrenPrefix}│  `);
						}
					}
				}
			};
			console.error("[hot] A pending update was not accepted, and reached the root module:");
			for (const chain of update.chain) {
				logChain(chain);
			}
			break;
		}

		case UpdateStatus.unacceptedEvaluation: {
			const { duration, loads, reevaluations } = update.stats();
			const ms = Math.round(duration);
			console.error(`[hot] Loaded ${loads} new ${plural("module", loads)}, reevaluated ${reevaluations} existing ${plural("module", reevaluations)} in ${ms}ms.`);
			console.error("[hot] Unaccepted update reached the root module. The application should be restarted!");
			break;
		}

	}
}

const acquireVisitIndex = makeAcquireVisitIndex();

/** @internal */
export class ReloadableModuleController implements AbstractModuleController {
	readonly reloadable = true;

	/** The currently "active" module instance */
	private current: ReloadableModuleInstance | undefined;
	/** During an update, but before this module is evaluated, this is what `current` will become */
	private pending: ReloadableModuleInstance | undefined;
	/** Durning an update, this is what `current` was and/or is */
	private previous: ReloadableModuleInstance | undefined;
	/** Written to at *any* time in response to the file watcher */
	private staging: ReloadableModuleInstance | undefined;
	/** Temporary, maybe "unlinked" instances used for link testing */
	private temporary: ReloadableModuleInstance | undefined;
	private fatalError: UpdateFatalError | undefined;
	private traversal = makeTraversalState();
	private visitIndex = 0;
	private version = 0;

	constructor(
		public readonly application: Application,
		public readonly url: string,
	) {
		const watcher = new FileWatcher();
		watcher.watch(this.url, () => {
			void (async () => {
				const instance = this.staging ?? this.current;
				assert.ok(instance !== undefined);
				const { importAssertions } = instance.declaration;
				const params = new URLSearchParams([
					[ "url", this.url ],
					[ "version", String(++this.version) ],
					[ "format", instance.declaration.format ],
					...Fn.map(
						Object.entries(importAssertions),
						([ key, value ]) => [ "with", String(new URLSearchParams([ [ key, value ] ])) ]),
				] as Iterable<[ string, string ]>);
				try {
					await import(`hot:reload?${String(params)}`);
				} catch (error) {
					console.log(error);
					return;
				}
				void this.application.requestUpdate();
			})();
		});
	}

	async main(this: ReloadableModuleController) {
		// Bind `requestUpdate` to the root module
		assert.equal(this.application.requestUpdate, defaultRequestUpdate);
		this.application.requestUpdate = debounceTimer(100, debounceAsync(async () => {
			const update = await this.requestUpdate();
			logUpdate(update);
		}));
		this.application.requestUpdateResult = () => this.requestUpdate();

		// Dispatch the module
		await this.dispatch();
	}

	async dispatch(this: ReloadableModuleController) {
		if (this.current === undefined) {
			// Place `current` from `staging` if it's not set up, instantiate all reloadable
			// modules, and perform link.
			traverseDepthFirst(
				this,
				node => node.traversal,
				(node, traversal) => {
					node.traversal = traversal;
					if (node.current === undefined) {
						const staging = node.select(controller => controller.staging);
						node.current = staging;
						node.current.instantiate();
					}
					return node.iterate();
				},
				(nodes): undefined => {
					const withRollback = iterateWithRollback(nodes, nodes => {
						for (const node of nodes) {
							if (node.select().unlink()) {
								node.current = undefined;
							}
						}
					});
					for (const node of withRollback) {
						node.select().link();
					}
				},
				pendingNodes => {
					for (const node of pendingNodes) {
						if (node.select().unlink()) {
							node.current = undefined;
						}
					}
				});

			// Evaluate
			await traverseDepthFirst(
				this,
				node => node.traversal,
				(node, traversal) => {
					node.traversal = traversal;
					return node.iterate();
				},
				async nodes => {
					for (const node of nodes) {
						const current = node.select();
						if (current === node.staging) {
							node.staging = undefined;
						}
						await current.evaluate();
					}
				});
		}
	}

	// Invoked from transformed module source
	load(
		body: ModuleBody,
		meta: ImportMeta | null,
		usesDynamicImport: boolean,
		format: Format,
		importAssertions: Record<string, string>,
		loadedModules: readonly LoadedModuleRequestEntry[],
	) {
		if (evictModule) {
			// Experimental module eviction
			if (this.version !== 0) {
				const backingModuleParams = new URLSearchParams([
					[ "url", this.url ],
					[ "version", String(this.version) ],
					...Object.entries(importAssertions).map(
						([ key, value ]) => [ "with", String(new URLSearchParams([ [ key, value ] ])) ]),
				] as Iterable<[ string, string ]>);
				const backingModuleURL = `hot:module?${String(backingModuleParams)}`;
				evictModule(backingModuleURL);
			}
		}
		const declaration: ModuleDeclaration = {
			body,
			meta,
			format,
			importAssertions,
			usesDynamicImport,
			loadedModules,
			indirectExportEntries: new Map(function*() {
				const predicate = Fn.somePredicate<BindingEntry, ExportIndirectEntry | ExportIndirectStarEntry>([
					discriminatedTypePredicate(BindingType.indirectExport),
					discriminatedTypePredicate(BindingType.indirectStarExport),
				]);
				for (const moduleRequest of loadedModules) {
					for (const binding of Fn.filter(moduleRequest.bindings, predicate)) {
						const as = binding.type === BindingType.indirectStarExport ? binding.as : binding.as ?? binding.name;
						yield [ as, { moduleRequest, binding } ];
					}
				}
			}()),
			starExportEntries: Array.from(function*() {
				const exportStarPredicate = discriminatedTypePredicate<BindingEntry, ExportStarEntry>(BindingType.exportStar);
				for (const moduleRequest of loadedModules) {
					for (const binding of Fn.filter(moduleRequest.bindings, exportStarPredicate)) {
						yield { moduleRequest, binding };
					}
				}
			}()),
		};
		this.staging = new ReloadableModuleInstance(this, declaration);
	}

	select(select = ReloadableModuleController.selectCurrent) {
		const instance = select(this);
		assert.ok(instance !== undefined);
		return instance;
	}

	private *iterate(select = ReloadableModuleController.selectCurrent) {
		for (const child of this.select(select).declaration.loadedModules) {
			const controller = child.controller();
			if (controller.reloadable) {
				yield controller;
			}
		}
	}

	private *iterateWithDynamics(
		select = ReloadableModuleController.selectCurrent,
		selectDynamic = ReloadableModuleController.selectCurrent,
	) {
		yield* this.iterate(select);
		const instance = this.select(selectDynamic);
		yield* Fn.map(instance.dynamicImports, entry => entry.controller);
	}

	private *traverse(
		iterate: (node: ReloadableModuleController) => Iterable<ReloadableModuleController> =
		node => node.iterateWithDynamics(),
	) {
		const [ release, visitIndex ] = acquireVisitIndex();
		try {
			yield* function *traverse(node: ReloadableModuleController): Iterable<ReloadableModuleController> {
				for (const child of iterate(node)) {
					if (child.visitIndex !== visitIndex) {
						child.visitIndex = visitIndex;
						yield child;
						yield* traverse(child);
					}
				}
			}(this);
		} finally {
			release();
		}
	}

	private async requestUpdate(this: ReloadableModuleController): Promise<UpdateResult> {

		// Check for previous unrecoverable error
		if (this.fatalError) {
			return this.fatalError;
		}

		// Set up statistics tracking
		let loads = 0;
		let reevaluations = 0;
		const timeStarted = performance.now();
		const stats = (): UpdateStats => ({
			loads,
			reevaluations,
			duration: performance.now() - timeStarted,
		});

		// Dispatch "dry run" to see if it is possible to accept this update. Also mark `previous`
		// and `pending`.
		interface DryRunResult {
			forwardResults: readonly DryRunResult[];
			declined: readonly ReloadableModuleController[];
			invalidated: readonly ReloadableModuleController[];
			hasDecline: boolean;
			hasNewCode: boolean;
			needsDispatch: boolean;
		}
		const nextControllers: ReloadableModuleController[] = [];
		const initialResult = traverseDepthFirst(
			this,
			node => node.traversal,
			(node, traversal) => {
				node.traversal = traversal;
				node.pending = node.staging ?? node.select();
				node.previous = node.current;
				return node.iterateWithDynamics(
					controller => controller.pending,
					controller => controller.previous ?? controller.pending);
			},
			(cycleNodes, forwardResults: readonly DryRunResult[]): DryRunResult => {
				let needsDispatch = false;
				let hasNewCode = false;
				const forwardUpdates = Array.from(Fn.concat(Fn.map(forwardResults, result => result.invalidated)));
				const invalidated = Array.from(Fn.filter(cycleNodes, node => {
					nextControllers.push(node);
					const nodeHasNewCode = node.previous !== node.pending;
					hasNewCode ||= nodeHasNewCode;
					if (
						nodeHasNewCode ||
						node.current === undefined ||
						isInvalidated(node.current) ||
						!isAccepted(node.current, forwardUpdates)
					) {
						needsDispatch = true;
						return node.current === undefined || !isAcceptedSelf(node.current);
					}
				}));
				const declined = Array.from(Fn.filter(invalidated, node => node.current !== undefined && isDeclined(node.current)));
				const hasDecline = declined.length > 0 || Fn.some(forwardResults, result => result.hasDecline);
				needsDispatch ||= Fn.some(forwardResults, result => result.needsDispatch);
				hasNewCode ||= Fn.some(forwardResults, result => result.hasNewCode);
				return { forwardResults, declined, invalidated, hasDecline, hasNewCode, needsDispatch };
			},
			pendingNodes => {
				for (const node of pendingNodes) {
					node.pending = undefined;
					node.previous = undefined;
				}
			});

		// Rollback routine which undoes the above traversal.
		const rollback = () => {
			for (const controller of nextControllers) {
				controller.pending = undefined;
				controller.previous = undefined;
			}
		};

		// Check result
		if (!initialResult.needsDispatch) {
			rollback();
			return undefined;
		} else if (initialResult.hasDecline) {
			rollback();
			const declined = Array.from(function *traverse(result): Iterable<ReloadableModuleController> {
				yield* result.declined;
				yield* Fn.transform(result.forwardResults, traverse);
			}(initialResult));
			return { type: UpdateStatus.declined, declined };
		} else if (initialResult.invalidated.length > 0) {
			// Tracing invalidations is actually pretty cumbersome because we need to compare cyclic
			// groups with the actual import entries to get something parsable by a human.
			const [ release, visitIndex ] = acquireVisitIndex();
			try {
				const chain = Array.from(function *traverse(result): Iterable<InvalidationChain> {
					// Don't re-traverse shared dependencies
					for (const node of result.invalidated) {
						if (node.visitIndex === visitIndex) {
							yield {
								modules: result.invalidated,
								next: null,
							};
							return;
						} else {
							node.visitIndex = visitIndex;
						}
					}
					const importedModules = new Set(Fn.transform(result.invalidated, function*(controller) {
						const current = controller.select();
						yield* current.iterateDependencies();
					}));
					const importedInvalidations = Array.from(Fn.transform(result.forwardResults, function*(result) {
						const invalidatedImports = result.invalidated.filter(controller => importedModules.has(controller));
						if (invalidatedImports.length > 0) {
							yield* traverse(result);
						}
					}));
					yield {
						modules: result.invalidated,
						next: function() {
							if (importedInvalidations.length === 0) {
								return undefined;
							} else if (importedInvalidations.every(result => result.next === null)) {
								// Also, skip branches that only include truncated results from the
								// "re-traverse" conditional above.
								return null;
							} else {
								return importedInvalidations;
							}
						}(),
					};
				}(initialResult));
				rollback();
				return { type: UpdateStatus.unaccepted, chain };
			} finally {
				release();
			}
		}

		// If the update contains new code then we need to make sure it will link. Normally the
		// graph will link and then evaluate, but when dispatching a hot update a module is allowed
		// to invalidate itself. So, we're not really sure which bindings will end up where. This
		// step ensures that a linkage error doesn't cause the whole graph to throw an error.
		if (initialResult.hasNewCode) {
			const instantiated: ReloadableModuleController[] = [];
			try {
				traverseDepthFirst(
					this,
					node => node.traversal,
					(node, traversal) => {
						node.traversal = traversal;
						return node.iterateWithDynamics(
							controller => controller.pending,
							controller => controller.previous ?? controller.pending);
					},
					(cycleNodes, forwardResults: readonly boolean[]) => {
						let hasUpdate = Fn.some(forwardResults);
						if (!hasUpdate) {
							for (const node of cycleNodes) {
								const pending = node.select(controller => controller.pending);
								if (pending !== node.current) {
									hasUpdate = true;
									break;
								}
							}
						}
						if (hasUpdate) {
							for (const node of cycleNodes) {
								const pending = node.select(controller => controller.pending);
								node.temporary = pending.clone();
								node.temporary.instantiate();
								instantiated.push(node);
							}
							for (const node of cycleNodes) {
								const temporary = node.select(controller => controller.temporary);
								temporary.link(controller => controller.temporary ?? controller.pending);
							}
						}
						return hasUpdate;
					});

			} catch (error) {
				rollback();
				return { type: UpdateStatus.linkError, error };

			} finally {
				for (const node of instantiated) {
					node.select(controller => controller.temporary).unlink();
					node.temporary = undefined;
				}
			}
		}

		// Collect previous controllers
		const previousControllers = Array.from(this.traverse());

		// Dispatch link & evaluate
		let dispatchLinkErrorType: UpdateStatus.fatalError | undefined;
		try {
			interface RunResult {
				forwardResults: readonly RunResult[];
				invalidated: readonly ReloadableModuleController[];
				treeDidUpdate: boolean;
			}
			const result = await traverseDepthFirst(
				this,
				node => node.traversal,
				(node, traversal) => {
					node.traversal = traversal;
					return node.iterateWithDynamics(
						controller => controller.pending,
						controller => controller.previous ?? node.pending);
				},
				async (cycleNodes, forwardResults: readonly RunResult[]): Promise<RunResult> => {
					let needsUpdate = false;
					// Check update due to new code
					for (const node of cycleNodes) {
						if (node.staging !== undefined || isInvalidated(node.select())) {
							needsUpdate = true;
							break;
						}
					}
					// Relink and check update due to invalidated dependencies
					const treeDidUpdate = Fn.some(forwardResults, result => result.treeDidUpdate);
					if (treeDidUpdate && !needsUpdate) {
						const forwardUpdates = Array.from(Fn.concat(Fn.map(forwardResults, result => result.invalidated)));
						for (const node of cycleNodes) {
							const current = node.select();
							current.relink();
							if (!await tryAccept(node.select(), forwardUpdates)) {
								needsUpdate = true;
								break;
							}
						}
					}
					if (!needsUpdate) {
						for (const node of cycleNodes) {
							assert.equal(node.current, node.pending);
							node.pending = undefined;
						}
						return { forwardResults, treeDidUpdate, invalidated: [] };
					}
					// These nodes need to be replaced.
					// 1) Instantiate
					for (const node of cycleNodes) {
						const pending = node.select(controller => controller.pending);
						const data = await async function() {
							try {
								return node.current === undefined ? undefined : await dispose(node.current);
							} catch (error) {
								console.error(`[hot] Caught error in module '${node.url}' during dispose:`);
								console.error(error);
								dispatchLinkErrorType = UpdateStatus.fatalError;
								throw error;
							}
						}();
						if (node.current === pending) {
							node.current = node.current.clone();
						} else {
							node.current = pending;
						}
						node.current.instantiate(data);
					}
					// 2) Link
					for (const node of cycleNodes) {
						node.select().link();
					}
					// 3) Evaluate
					const withRollback = iterateWithRollback(cycleNodes, nodes => {
						for (const node of nodes) {
							const current = node.select();
							assert.ok(current.state.status === ModuleStatus.evaluated);
							if (current.state.evaluationError !== undefined) {
								node.current = node.previous;
							}
						}
					});
					for (const node of withRollback) {
						const current = node.select();
						if (node.previous !== undefined && current.declaration === node.previous.declaration) {
							++reevaluations;
						} else {
							++loads;
						}
						await current.evaluate();
						node.pending = undefined;
						if (current === node.staging) {
							node.staging = undefined;
						}
					}
					// Try self-accept
					const invalidated: ReloadableModuleController[] = [];
					for (const node of cycleNodes) {
						if (node.previous !== undefined) {
							const current = node.select();
							const namespace = () => current.moduleNamespace()();
							if (!await tryAcceptSelf(node.previous, namespace)) {
								invalidated.push(node);
							}
						}
					}
					return { forwardResults, invalidated, treeDidUpdate: true };
				});

			if (!result.treeDidUpdate) {
				// Strange that got here since it should have been caught in the precheck traversal.
				return undefined;
			}

		} catch (error) {
			// Re-link everything to ensure consistent internal state. Also, throw away pending
			// instances.
			traverseDepthFirst(
				this,
				node => node.traversal,
				(node, traversal) => {
					node.traversal = traversal;
					if (node.pending !== undefined) {
						node.pending.unlink();
						node.pending = undefined;
					}
					return node.iterateWithDynamics();
				},
				(cycleNodes): undefined => {
					for (const node of cycleNodes) {
						const current = node.select();
						current.relink();
					}
				});
			if (dispatchLinkErrorType === undefined) {
				return { type: UpdateStatus.evaluationFailure, error, stats };
			} else {
				return this.fatalError = { type: dispatchLinkErrorType, error };
			}

		} finally {
			// Dispose old modules
			const currentControllers = new Set(function*(that) {
				for (const node of that.traverse()) {
					assert.ok(node.pending === undefined);
					node.previous = undefined;
					yield node;
				}
			}(this));
			for (const controller of previousControllers) {
				if (!currentControllers.has(controller)) {
					const current = controller.select();
					try {
						await prune(current);
					} catch (error) {
						console.error(`[hot] Caught error in module '${controller.url}' during prune:`);
						console.error(error);
						// eslint-disable-next-line no-unsafe-finally
						return this.fatalError = { type: UpdateStatus.fatalError, error };
					}
					// Move the instance to staging to setup for `dispatch` in case it's re-imported
					controller.staging = current.clone();
					controller.current = undefined;
					controller.previous = undefined;
				}
			}
		}

		return {
			type: UpdateStatus.success,
			stats,
		};
	}

	private static selectCurrent(this: void, controller: ReloadableModuleController) {
		return controller.current;
	}
}
