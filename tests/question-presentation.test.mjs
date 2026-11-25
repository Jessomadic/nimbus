import test from 'node:test';
import assert from 'node:assert/strict';
import {questionPresentation,renderQuestionCard} from '../public/question-card.js';
import {traceWaitingLabel} from '../public/trace-state.js';
import {describeTraceStep} from '../public/trace-activity.js';

test('legacy checker question has an understandable summary with the complete original retained in closed details',()=>{
  const original='The mandatory checker SHA '+ 'a'.repeat(64)+' reads google-install-r2-binding.json but requires r3 SHA '+ 'b'.repeat(64)+'. Please supply a corrected checker.';
  const presentation=questionPresentation({question:original});
  assert.equal(presentation.title,'A migration check points to the wrong file');assert.equal(presentation.details,original);
  assert.doesNotMatch([presentation.title,presentation.context,presentation.prompt,presentation.recommendation].join(' '),/[a-f0-9]{40}|google-install|SHA/);
  const html=renderQuestionCard({id:89,status:'pending',audience:'host',questions:[{question:original}]});
  assert.match(html,/Automatic recovery requested\. You do not need to answer/);assert.doesNotMatch(html,/Your input is needed|<details[^>]*\bopen\b/);
  assert.match(html,/<details class="question-details"><summary>Technical details<\/summary><p>The mandatory checker SHA/);
  assert.match(html,/<details class="question-override"><summary>Answer yourself/);
});

test('real owner decisions retain choices and readable context; all supplied content is escaped',()=>{
  const item={title:'Choose a destination',context:'Reports need a home.',question:'Which folder should be used?',recommendation:'Keep reports together.',details:'<img src=x onerror=alert(1)>',options:['Team reports','Personal reports']};
  const html=renderQuestionCard({id:12,version:4,status:'pending',audience:'human',reason:'<script>bad</script>',questions:[item]});
  assert.match(html,/Your input is needed/);assert.match(html,/Reports need a home/);assert.match(html,/Nimbus recommends/);
  assert.equal((html.match(/data-question-answer=/g)||[]).length,1);assert.match(html,/data-question-choice="0"/);assert.match(html,/data-question-version="4"/);
  assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/&lt;img/);assert.match(html,/Coordination details/);
  const child=renderQuestionCard({id:12,status:'pending',audience:'human',interactive:false,questions:[item]});assert.doesNotMatch(child,/<textarea|data-answer-question/);
});

test('generic technical details are not turned into an invented answer or automatically selected choice',()=>{
  const q='Need account mapping for C:/private/settings with digest '+ 'c'.repeat(64);
  const p=questionPresentation({question:q});assert.equal(p.details,q);assert.equal(p.recommendation,'');
  const html=renderQuestionCard({id:2,status:'pending',audience:'coordinator',questions:[{question:q,options:['A','B']}]});
  assert.doesNotMatch(html,/\bselected\b|<details[^>]*\bopen\b/);assert.match(html,/value="">Choose an answer/);
});

test('activity distinguishes automatic coordination and recovery from a real owner question',()=>{
  const waiting=waitReason=>[{tool:'request_user_input',state:'waiting',waitReason}];
  assert.equal(traceWaitingLabel(waiting('coordination')),'The Orchestrator is resolving a question');
  assert.equal(traceWaitingLabel(waiting('recovery')),'Waiting for automatic recovery');
  assert.equal(traceWaitingLabel(waiting('input')),'Waiting for your answer');
  assert.equal(describeTraceStep({tool:'request_user_input',input:{questions:[{title:'Choose a destination',question:'Internal technical text'}]}}),'Resolving a question: Choose a destination');
});
