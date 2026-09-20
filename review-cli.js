export function registerReviewCommands(program,readAuth,forgetDraft) {
  program.command('destroy <draft-id>').description('Unpublish your draft and all its version links')
    .option('-y, --yes','Confirm unpublishing this draft')
    .action(async(draftId,options)=>{
      if(!options.yes) throw new Error('This unpublishes the draft. Repeat with --yes to confirm.');
      const {apiUrl,apiKey}=readAuth();
      const response=await fetch(`${apiUrl.replace(/\/$/,'')}/api/drafts/${encodeURIComponent(draftId)}`,{method:'DELETE',headers:{Authorization:`Bearer ${apiKey}`}});
      if(!response.ok) throw new Error(`Destroy failed (${response.status}). Local mappings were not changed.`);
      try {forgetDraft(draftId);}
      catch(error) {throw new Error(`Draft unpublished, but local mapping cleanup failed: ${error.message}`);}
      console.log(`Unpublished draft ${draftId}. Stored history is retained by the server.`);
    });
  program.command('comments <draft-id>').description('Read anchored review comments on your draft')
    .option('--json','Output JSON for an agent')
    .action(async(draftId,options)=>{
      const {apiUrl,apiKey}=readAuth();
      const comments=[];
      for(let offset=0;;offset+=100) {
        const response=await fetch(`${apiUrl.replace(/\/$/,'')}/api/drafts/${encodeURIComponent(draftId)}/comments?offset=${offset}`,{headers:{Authorization:`Bearer ${apiKey}`}});
        if(!response.ok) throw new Error(`Read comments failed (${response.status})`);
        const page=await response.json();
        comments.push(...page);
        if(page.length<100) break;
      }
      if(options.json) { console.log(JSON.stringify(comments));return; }
      if(!comments.length) { console.log('No comments.');return; }
      for(const c of comments) console.log(`${c.id} | ${c.author_name} | ${c.created_at} | version ${c.version}\nAnchor (${c.anchor.type}): ${c.anchor.selector}\nQuote: ${c.anchor.quote}\nContext: ${c.anchor.prefix} [${c.anchor.quote}] ${c.anchor.suffix}\n${c.body}\n`);
    });
}
