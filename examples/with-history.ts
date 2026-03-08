import './env.js';
import { prompt } from '../src/index.js';

const { data } = await prompt`
  ${prompt.messages([
    { role: 'user', content: 'My name is Alice and I live in Zurich.' },
    { role: 'assistant', content: 'Nice to meet you, Alice! Zurich is a beautiful city.' },
  ])}

  What is my name and where do I live? Answer in one short sentence.
`();

console.log('\n=== Response ===');
console.log(data);
