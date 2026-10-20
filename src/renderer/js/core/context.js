/**
 * 应用上下文：各会话视图共享的依赖容器。
 *
 * 视图只从这个对象取依赖，而不是直接访问全局变量，这样便于测试时注入
 * 假的桥（fake api）和假的翻译函数。
 *
 * `openSession(kind, initial)` 由应用外壳在启动后注入：文件夹比较等视图
 * 需要"双击文件 → 在新标签页里打开文本比较"，又不希望直接依赖 app.js
 * （那会形成循环引用）。
 */
export function createAppContext(api, t) {
  return {
    api,
    t,
    /** 打开新会话并预填路径；未注入时是一个安全的空实现。 */
    openSession: undefined,
  };
}
