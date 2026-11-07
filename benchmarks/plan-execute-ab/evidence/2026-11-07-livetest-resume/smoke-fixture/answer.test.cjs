const fs=require('node:fs');const assert=require('node:assert/strict');require('node:test')('answer',()=>assert.equal(fs.readFileSync('answer.txt','utf8').trim(),'42'));
