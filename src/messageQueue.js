function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GroupQueue {
  constructor(cooldownMs) {
    this.cooldownMs = cooldownMs;
    this.chains = new Map();
    this.lastRunByGroup = new Map();
  }

  enqueue(groupId, task) {
    const previous = this.chains.get(groupId) || Promise.resolve();

    const current = previous
      .catch(() => {
        // Mantem a fila ativa mesmo se uma tarefa anterior falhar.
      })
      .then(async () => {
        const lastRun = this.lastRunByGroup.get(groupId) || 0;
        const diff = Date.now() - lastRun;

        if (diff < this.cooldownMs) {
          await sleep(this.cooldownMs - diff);
        }

        const result = await task();
        this.lastRunByGroup.set(groupId, Date.now());
        return result;
      });

    this.chains.set(
      groupId,
      current.finally(() => {
        if (this.chains.get(groupId) === current) {
          this.chains.delete(groupId);
        }
      })
    );

    return current;
  }
}
