import './env.js';
import { prompt } from '../src/index.js';

// Each prompt call returns token usage with call and cumulative breakdowns
const r1 = await prompt`What is the capital of France?`();
console.log('Response:', r1.data);
console.log('Call usage:', r1.usage?.call);
// => { promptTokens: 14, completionTokens: 8, totalTokens: 22 }

// On the first call, cumulative equals call
console.log('Cumulative:', r1.usage?.cumulative);
// => { promptTokens: 14, completionTokens: 8, totalTokens: 22 }

// Chained calls automatically track cumulative usage
const r2 = await r1.next`And what is its population?`();
console.log('\nFollow-up call usage:', r2.usage?.call);
console.log('Cumulative after 2 calls:', r2.usage?.cumulative);
// cumulative = r1 + r2 token counts

// Use cumulative to decide when to compact context
if ((r2.usage?.cumulative.totalTokens ?? 0) > 4000) {
  console.log('Context getting large, consider compaction');
}
