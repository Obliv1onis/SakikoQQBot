'use strict';

// 每个用户的生成、发送和历史写入作为一个任务串行执行。
// reset 会让旧任务失效；即使服务端忽略 abort，旧结果也不能继续发送。
class ConversationQueue {
  constructor() {
    this.users = new Map();
  }

  entry(userId) {
    if (!this.users.has(userId)) {
      this.users.set(userId, { generation: 0, activity: 0, tail: Promise.resolve(), tasks: new Set() });
    }
    return this.users.get(userId);
  }

  touch(userId) {
    const entry = this.entry(userId);
    entry.activity++;
    for (const task of entry.tasks) {
      if (task.background) task.controller.abort();
    }
  }

  reset(userId) {
    const entry = this.entry(userId);
    entry.generation++;
    for (const task of entry.tasks) task.controller.abort();
    entry.tail = Promise.resolve();
  }

  run(userId, callback, { background = false } = {}) {
    const entry = this.entry(userId);
    const generation = entry.generation;
    const activity = entry.activity;
    const controller = new AbortController();
    const task = { background, controller };
    entry.tasks.add(task);
    const context = {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted && entry.generation === generation &&
        (!background || entry.activity === activity),
      hasNewActivity: () => entry.activity !== activity,
    };
    // 即使上游模型忽略 abort，也立即释放队列；旧任务只能通过 isCurrent 守卫写入。
    let onAbort;
    const cancelled = new Promise((resolve) => {
      onAbort = () => resolve(false);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const work = entry.tail.then(() => context.isCurrent() ? callback(context) : false);
    const result = Promise.race([work, cancelled]);
    entry.tail = result.catch(() => {});
    return result.finally(() => {
      controller.signal.removeEventListener('abort', onAbort);
      entry.tasks.delete(task);
    });
  }

  close() {
    for (const userId of this.users.keys()) this.reset(userId);
  }
}

module.exports = { ConversationQueue };
