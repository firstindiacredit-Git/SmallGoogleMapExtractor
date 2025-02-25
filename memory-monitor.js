const v8 = require('v8');

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
}

module.exports = monitorMemory; 