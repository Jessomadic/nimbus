import { q } from '../db.js';
import {validateQuestions} from './question-routing.js';
export {validateQuestions};

let router;
export function setQuestionRouter(value){router=value;}
export function answerQuestion(id,answers,host) {
  if(router)return router.answerHuman(Number(id),answers,host);
  const row=q('SELECT * FROM task_questions WHERE id=?').get(Number(id));
  if(!row||row.status!=='pending')throw new Error('Question is no longer pending');
  const questions=JSON.parse(row.questions);
  if(!Array.isArray(answers)||answers.length!==questions.length||answers.some(a=>typeof a!=='string'||!a.trim()||a.length>16000))throw new Error('Answer each question');
  q("UPDATE task_questions SET answers=?,status='answered' WHERE id=? AND status='pending'").run(JSON.stringify(answers),row.id);
  return {...row,status:'answered',answers:JSON.stringify(answers)};
}
