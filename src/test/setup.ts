import 'fake-indexeddb/auto'
// 缓存 dbPromise 的模块级单例在 vitest 的多测试间共享，这里用真实 indexedDB（fake-indexeddb）
// 结合各测试文件内 beforeEach 调用 resetDB() + clearAllStores() 做隔离。