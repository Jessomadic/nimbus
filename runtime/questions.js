import { q } from '../db.js';

export function validateQuestions(questions) {
  if(!Array.isArray(questions)||!questions.length||questions.length>3||questions.some(item=>typeof item.question!=='string'||!item.question.trim()||item.question.length>4000||item.options!==undefined&&(!Array.isArray(item.options)||item.options.length>3||item.options.some(o=>typeof o!=='string'||!o.trim()||o.length>500))))throw new Error('Provide 1 to 3 concise questions and up to 3 answer options each');
  return questions;
}
export function answerQuestion(id,answers) {
  const row=q('SELECT * FROM task_questions WHERE id=?').get(Number(id));
  if(!row||row.status!=='pending')throw new Error('Question is no longer pending');
  const questions=JSON.parse(row.questions);
  if(!Array.isArray(answers)||answers.length!==questions.length||answers.some(a=>typeof a!=='string'||!a.trim()||a.length>16000))throw new Error('Answer each question');
  q("UPDATE task_questions SET answers=?,status='answered' WHERE id=? AND status='pending'").run(JSON.stringify(answers),row.id);
  return {...row,status:'answered',answers:JSON.stringify(answers)};
}
