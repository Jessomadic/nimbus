// Host HTTP adapter. Authentication/CSRF and actor identity come only from the
// installed server; request bodies cannot supply principals or coordinator IDs
// to an answer operation. Rebinding is a separate authenticated host command.
export function registerQuestionRoutes({route,router,body,json,authenticate,rebindOwner,principal,listPending,broadcast=()=>{}}){
  const owner=(req,res)=>authenticate(req,res)?{authenticated:true,principal:principal(req)}:null;
  const fail=(res,error)=>json(res,error.statusCode||400,{error:error.message,code:error.code});
  route('GET','/api/questions',(req,res)=>{if(owner(req,res))json(res,200,router.listHuman());});
  route('GET','/api/questions/inbox',(req,res)=>{if(owner(req,res))json(res,200,listPending().map(id=>router.get(id)));});
  route('POST','/api/questions/:id/answer',async(req,res,p)=>{
    if(!owner(req,res))return;
    try{const input=await body(req),host=owner(req,res);if(!host)return;
      if(Object.keys(input).some(key=>!['answers','expectedVersion','idempotencyKey'].includes(key)))throw new Error('Unsupported question answer fields');
      const result=router.answerHuman(p.id,input.answers,{...host,expectedVersion:input.expectedVersion,idempotencyKey:input.idempotencyKey});
      broadcast('state_changed',{});json(res,200,result);
    }catch(error){fail(res,error);}
  });
  route('POST','/api/questions/:id/rebind',async(req,res,p)=>{
    if(!rebindOwner(req,res))return;
    try{const input=await body(req);if(!rebindOwner(req,res))return;
      if(Object.keys(input).some(key=>!['expectedVersion','coordinatorRunId','reason'].includes(key)))throw new Error('Unsupported question rebind fields');
      const result=router.rebind({...input,questionId:Number(p.id)},{authenticated:true,principal:principal(req)});
      broadcast('state_changed',{});json(res,200,result);
    }catch(error){fail(res,error);}
  });
}
