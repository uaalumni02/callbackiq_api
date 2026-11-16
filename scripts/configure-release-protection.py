#!/usr/bin/env python3
"""Apply and verify explicit release protection using the user's gh authentication."""
import argparse, json, subprocess
parser=argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true', help='Apply the displayed settings; otherwise preview only')
args=parser.parse_args()
checks={
 'callbackiq_api':['Release certification','Replica-set concurrency guard','browser','repository-and-dependency-audit','history'],
 'callbackiq_frontend':['Test and build','browser','repository-and-dependency-audit','history'],
}
for repo, contexts in checks.items():
 payload={'required_status_checks':{'strict':True,'contexts':contexts},'enforce_admins':True,
   'required_pull_request_reviews':None,'restrictions':None,'allow_force_pushes':False,'allow_deletions':False}
 for branch in ['development','main']:
  endpoint=f'repos/uaalumni02/{repo}/branches/{branch}/protection'
  print(f'{repo}:{branch}: {json.dumps(payload)}',flush=True)
  if args.apply:
   subprocess.run(['gh','api','--method','PUT',endpoint,'--input','-'],input=json.dumps(payload),text=True,check=True,stdout=subprocess.DEVNULL)
   actual=json.loads(subprocess.check_output(['gh','api',endpoint],text=True))
   assert actual['enforce_admins']['enabled'] and not actual['allow_force_pushes']['enabled'] and not actual['allow_deletions']['enabled']
   assert set(contexts)<=set(actual['required_status_checks']['contexts'])
   print('Verified protection:',repo,branch)
