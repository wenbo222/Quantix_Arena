import {redirect} from 'next/navigation';
import {cookies} from 'next/headers';
import {supabase} from '@lib/supabaseClient';
import ResultsClient from './ResultsClient';

async function checkCompetitionId(competition_id: number | null) {
  if (competition_id === null) {
    return {valid: false, over: false, results_out: false, started: false, id: 0};
  }

  const {data, error} = await supabase.rpc('validate_competition', {
    check_id: competition_id
  })
  .select('id, end_datetime, start_datetime, released_scores')
  .maybeSingle();

  if (error || !data) {
    return {valid: false, over: false, results_out: false, started: false, id: 0};
  }

  const now = new Date();
  return {valid: true, over: new Date(data.end_datetime) < now, results_out: data.released_scores, started: new Date(data.start_datetime) < now, id: data.id};
}

export default async function ResultsPage() {
  const cookieStore = await cookies();
  const competition_id = cookieStore.get('competitionId');
  const competition_id_parsed = competition_id ? parseInt(competition_id.value, 10) : null;
  const cid = await checkCompetitionId(competition_id_parsed);
  if (!cid.valid) {
    return redirect('/join');
  }

  if (cid.over) {
    if (!cid.results_out) {
      return redirect('/over');
    }
  }
  else {
    return redirect('/details');
  }

  return <ResultsClient/>;
}