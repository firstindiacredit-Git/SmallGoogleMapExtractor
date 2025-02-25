const v8 = require('v8');

const MEMORY_THRESHOLD = 800; // 800MB threshold for t2.micro

function formatBytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function monitorMemory() {
  const used = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  
  console.log('Memory Usage:');
  console.log('RSS:', formatBytes(used.rss));
  console.log('Heap Used:', formatBytes(used.heapUsed));
  console.log('Heap Total:', formatBytes(used.heapTotal));
  console.log('External:', formatBytes(used.external));
  console.log('Heap Size Limit:', formatBytes(heapStats.heap_size_limit));

  if (used.heapUsed > MEMORY_THRESHOLD * 1024 * 1024) {
    console.warn('Memory usage too high, triggering GC');
    if (global.gc) {
      global.gc();
    }
  }
}

// Call more frequently
setInterval(monitorMemory, 10000);

module.exports = monitorMemory; 