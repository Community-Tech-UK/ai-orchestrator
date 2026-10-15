import { TestBed } from '@angular/core/testing';
import { expect, it } from 'vitest';
import { LoopScorecardComponent } from './loop-scorecard.component';
import { LoopScorecardService } from '../../core/services/ipc/loop-scorecard.service';
import type { LoopScorecard } from '../../../../shared/types/loop-spend.types';
it('renders unrecorded metrics as dashes and includes every denominator', async () => {
  const card: LoopScorecard = {costCents:0,tokens:0,knownCents:0,unattributedCents:0,unattributedTokens:0,byPurpose:{},legacyRounds:0,rounds:2,roundsAfterLedgerClosed:1,stepLimitedRounds:0,recordedStopRounds:0,stopReasons:{},medianPromptBytes:null,finishedTasks:null,totalTasks:null,unknownCalls:1};
  TestBed.configureTestingModule({imports:[LoopScorecardComponent],providers:[{provide:LoopScorecardService,useValue:{get:async()=>card}}]});
  const fixture = TestBed.createComponent(LoopScorecardComponent); fixture.componentRef.setInput('loopRunId','run'); fixture.detectChanges();
  await fixture.whenStable(); fixture.detectChanges();
  const text = fixture.nativeElement.textContent as string;
  expect(text).toContain('Run scorecard'); expect(text).toContain('1 of 2'); expect(text).toContain('0 of 0 with a recorded reason'); expect(text).toContain('Tokens per finished task: -'); expect(text).not.toMatch(/NaN|Infinity/);
});
