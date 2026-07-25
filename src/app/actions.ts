'use server';

import {supabase} from '@lib/supabaseClient';
import {cookies} from 'next/headers';
import crypto from 'crypto';

type QuestionOption = {option_text: string};
type Question = {
  question: string;
  id: number;
  type: 'mcq' | 'fill';
  options: string[];
  diagram?: string | null;
};
type RawQuestion = {
  question: string;
  type: 'mcq' | 'fill';
  id: number;
  diagram?: string | null;
  question_options: QuestionOption[];
  answer: string;
  points: number;
};
type ParticipantAnswer = {
  question_id: number;
  question_text: string;
  question_type: 'mcq' | 'fill';
  submitted_answer: string;
  correct_answer: string;
  points: number;
};

function getIdentifiersHash(values: Record<string, string>) {
  const sorted = Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
  return crypto.createHash('md5').update(sorted).digest('hex');
}

function getPasswordHash(password: string) {
  return crypto.createHash('md5').update(password).digest('hex');
}

export async function validateCompetition(unprocessed_code: string) {
  const code = unprocessed_code.trim().toLowerCase();

  const {data, error} = await supabase.rpc('validate_competition', {
    check_code: code
  })
  .select('id, end_datetime, released_scores')
  .maybeSingle();

  if (error) {
    return {valid: false, message: 'Server error'};
  }
  if (!data) {
    return {valid: false, message: 'Invalid code'};
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: 'competitionId',
    value: data.id,
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
  });

  const now = new Date();
  if (data.end_datetime && new Date(data.end_datetime) < now) {
    return {valid: true, competitionId: data.id, message: '', ended: true, scores: data.released_scores};
  }

  return {valid: true, competitionId: data.id, message: '', ended: false};
}

export async function fetchFields(competitionId: number) {
  const {data, error} = await supabase
    .from('competition_identifiers')
    .select('identifier_name, like_check')
    .eq('competition_id', competitionId)
    .order('id', {ascending: true});

  if (error) {
    return {success: false, message: 'Server error', data: [], checks: []};
  }

  if (!data || data.length === 0) {
    return {success: true, message: '', data: [], checks: []};
  }

  return {success: true, message: '', data: data.map(row => row.identifier_name), checks: data.map(row => row.like_check)};
}

export async function verifyParticipant(competitionId: number, values: Record<string, string>) {
  const identifiersHash = getIdentifiersHash(values);

  const {data: existing, error: checkError} = await supabase
    .from('participants')
    .select('*')
    .eq('competition_id', competitionId)
    .eq('identifiers_hash', identifiersHash)
    .maybeSingle();

  if (checkError) {
    return {success: false, message: 'Server error'};
  }

  if (existing) {
    return {success: true, message: '', exists: true};
  }

  return {success: true, message: '', exists: false};
}

export async function createParticipant(competitionId: number, values: Record<string, string>, password: string) {
  const identifiersHash = getIdentifiersHash(values);
  const passwordHash = getPasswordHash(password);

  const {data: existing, error: checkError} = await supabase
    .from('participants')
    .select('*')
    .eq('competition_id', competitionId)
    .eq('identifiers_hash', identifiersHash)
    .maybeSingle();

  if (checkError) {
    return {success: false, message: 'Server error'};
  }

  if (existing) {
    if (existing.password_hash === passwordHash) {
      const cookieStore = await cookies();
      cookieStore.set({
        name: 'participantId',
        value: existing.id,
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7,
      });
      return {success: true, message: ''};
    }
    else {
      return {success: false, message: 'Wrong password'};
    }
  }
  else {
    const {data: participant, error: insertError} = await supabase
      .from('participants')
      .insert({competition_id: competitionId, identifiers_hash: identifiersHash, password_hash: passwordHash})
      .select('*')
      .maybeSingle();

    if (insertError) {
      return {success: false, message: 'Server error'};
    }

    const identifiers = Object.entries(values).map(([name, value]) => ({
      participant_id: participant.id,
      identifier_name: name,
      identifier_value: value,
    }));

    const {error: idError} = await supabase
      .from('participant_identifiers')
      .insert(identifiers);

    if (idError) {
      return {success: false, message: 'Server error'};
    }

    const cookieStore = await cookies();
    cookieStore.set({
      name: 'participantId',
      value: participant.id,
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
    });
    return {success: true, message: ''};
  }
}

export async function getStartTime(competitionId: number) {
  const {data, error} = await supabase
    .rpc('get_start_time', {
      check_id: competitionId
    })
    .select('start_datetime, name')
    .maybeSingle();

  if (error || !data) {
    return {success: false, message: 'Server error'};
  }

  return {success: true, start: data.start_datetime, name: data.name, message: ''};
}

export async function getContestData(competitionId: number) {
  const {data, error} = await supabase
    .rpc('validate_competition', {
      check_id: competitionId
    })
    .select('end_datetime, name')
    .maybeSingle();

  if (error || !data) {
    return {success: false, message: 'Server error'};
  }

  const {data: questionsData, error: qerror} = await supabase
    .from('questions')
    .select('question, type, id, diagram, question_options(option_text), answer, points')
    .eq('competition_id', competitionId)
    .order('order_index', {ascending: true});

  if (qerror) {
    return {success: false, message: 'Server error'};
  }

  const formattedQuestions: Question[] = (questionsData || []).map((q: RawQuestion) => ({
    question: q.question,
    type: q.type,
    id: q.id,
    options: q.type === 'mcq' ? q.question_options.map((opt: QuestionOption) => opt.option_text) : [],
    diagram: q.diagram || null
  }));

  const answersDict: Record<number, string> = (questionsData || []).reduce(
    (acc, q: RawQuestion) => {
      acc[q.id] = q.answer;
      return acc;
    },
    {} as Record<number, string>
  );

  const pointsDict: Record<number, number> = (questionsData || []).reduce(
    (acc, q: RawQuestion) => {
      acc[q.id] = q.points;
      return acc;
    },
    {} as Record<number, number>
  );

  return {success: true, end: data.end_datetime, name: data.name, questions: formattedQuestions, answers: answersDict, points: pointsDict, message: ''};
}

export async function submit(competitionId: number, participantId: number, values: Record<number, string>) {
  const {data, error} = await supabase
    .rpc('validate_participant_no_submit', {
      check_id: participantId
    })
    .select('submitted')
    .maybeSingle();

  if (error || !data) {
    return {success: false, message: 'Server error'};
  }

  if (data.submitted) {
    return {success: false, message: 'Already submitted'};
  }

  const answerRows = Object.entries(values).map(([questionId, submittedAnswer]) => ({
    participant_id: participantId,
    question_id: Number(questionId),
    submitted_answer: submittedAnswer,
  }));

  const {error: insertError} = await supabase
    .from('answers')
    .insert(answerRows)

  if (insertError) {
    return {success: false, message: 'Server error'};
  }

  const now = new Date();

  const {error: updateError} = await supabase
    .from('participants')
    .update({submitted: true, submitted_at: now})
    .eq('id', participantId)

  if (updateError) {
    return {success: false, message: 'Server error'};
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: 'fromContest',
    value: 'true',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30,
  });

  return {success: true, message: ''};
}

export async function strike(participantId: number) {
  const {data: participant, error: fetchError} = await supabase
    .from('participants')
    .select('leave_attempts, last_attempt')
    .eq('id', participantId)
    .single();

  if (fetchError) {
    return {success: false, message: 'Server error'};
  }

  const now = new Date();
  const last = new Date(participant.last_attempt)

  if (now.getTime() - last.getTime() < 5000) {
    return {success: false, message: '', warning: true};
  }

  const {data, error} = await supabase
    .from('participants')
    .update({leave_attempts: participant.leave_attempts + 1, last_attempt: now})
    .eq('id', participantId)
    .select('leave_attempts')
    .single();

  if (error) {
    return {success: false, message: 'Server error'};
  }

  if (data.leave_attempts < 2) {
    return {success: false, message: '', warning: true};
  }
  else if (data.leave_attempts < 3) {
    return {success: true, message: '', warning: true, num: 1};
  }
  else if (data.leave_attempts < 4) {
    return {success: true, message: '', warning: true, num: 2};
  }

  return {success: true, message: '', warning: false};
}

export async function leave(participantId: number) {
  const now = new Date();
  const {error} = await supabase
    .from('participants')
    .update({last_attempt: now})
    .eq('id', participantId)

  if (error) {
    return {success: false, message: 'Server error'};
  }

  return {success: true, message: ''};
}

export async function setTestingWindow(participantId: number) {
  const {error} = await supabase
    .rpc('set_testing_window', {
      check_id: participantId
    })

  if (error) {
    return {success: false, message: 'Server error'};
  }

  return {success: true, message: ''};
}

export async function verifyParticipantResults(competitionId: number, values: Record<string, string>) {
  const identifiers = Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== 'Password')
  );
  const identifiersHash = getIdentifiersHash(identifiers);
  const passwordHash = getPasswordHash(values['Password']);

  const {data: existing, error: checkError} = await supabase
    .from('participants')
    .select('*')
    .eq('competition_id', competitionId)
    .eq('identifiers_hash', identifiersHash)
    .eq('password_hash', passwordHash)
    .maybeSingle();

  if (checkError) {
    return {success: false, message: 'Server error'};
  }

  if (!existing) {
    return {success: false, message: 'Participant not found'};
  }

  return {success: true, message: '', pid: existing.id};
}

export async function getResults(competitionId: number, participantId: number) {
  const {data, error} = await supabase.rpc('get_participant_score', {
    p_pid: participantId,
    p_cid: competitionId
  });

  if (error) {
    return {success: false, message: 'Server error'};
  }

  if (!data || data.length === 0) {
    return {success: false, message: 'Participant not found'};
  }

  const row = data[0];
  return {success: true, message: '', identifiers: row.identifiers, score: row.total_score, submit_time: row.submit_time, max: row.max_score};
}

export async function getAnswers(competitionId: number, participantId: number) {
  const {data, error} = await supabase.rpc('get_participant_answers', {
    p_pid: participantId,
    p_cid: competitionId
  });

  if (error) {
    return {success: false, message: 'Server error'};
  }

  const answersArray = data as ParticipantAnswer[];

  const answersDict: Record<number, string> = answersArray.reduce((acc, ans) => {
    acc[ans.question_id] = ans.submitted_answer;
    return acc;
  }, {} as Record<number, string>);

  const pointsReceived: Record<number, number> = answersArray.reduce((acc, ans) => {
    acc[ans.question_id] = ans.points;
    return acc;
  }, {} as Record<number, number>);

  return {success: true, message: '', answers: answersDict, points: pointsReceived};
}

export async function findContests(hostId: number) {
  const {data, error} = await supabase
    .rpc('get_contests', {
      check_id: hostId
    })
    .select('start_datetime, end_datetime, participants_count, submissions, name, competition_id')

  if (error) {
    return {success: false, message: 'Server error'};
  }

  return {success: true, data: data, message: ''};
}

export async function findParticularContest(contestId: number) {
  const {data, error} = await supabase
    .rpc('get_one_contest', {
      contest_id: contestId
    })
    .select('start_datetime, end_datetime, participants_count, submissions, name, competition_id')
    .maybeSingle()

  if (error || !data) {
    return {success: false, message: 'Server error'};
  }

  return {success: true, data: data, message: ''};
}

export async function getTestingWindows(contestId: number) {
  const {data, error} = await supabase
    .rpc('get_testing_windows', {
      contest_id: contestId
    })
    .select('start_datetime, end_datetime')

  if (error || !data) {
    return {success: false, message: 'Server error'};
  }

  return {success: true, data: data, message: ''};
}

export async function getIdentifiers(contestId: number) {
  const {data, error} = await supabase
    .rpc('get_identifiers', {
      contest_id: contestId
    })
    .select('identifier')

  if (error || !data) {
    return {success: false, message: 'Server error'};
  }

  const identifiersList = Array.isArray(data) ? data.map(row => row.identifier) : [data.identifier];
  return {success: true, data: identifiersList, message: ''};
}

export async function getParticipantData(contestId: number) {
  const {data, error} = await supabase
    .rpc('get_participant_data', {
      contest_id: contestId
    })
    .select('participant_id, identifiers, total_score, max_score, submitted, started_at, submitted_at, warnings')

  if (error) {
    return {success: false, message: 'Server error'};
  }

  return {success: true, data: data, message: ''};
}

export async function getIndividualParticipantData(contestId: number, participantId: number) {
  const {data, error} = await supabase
    .rpc('get_participant_data', {
      contest_id: contestId,
      participant_id: participantId
    })
    .select('participant_id, identifiers, total_score, max_score, submitted, started_at, submitted_at, warnings')
    .maybeSingle()

  if (error || !data) {
    return {success: false, message: 'Server error'};
  }

  return {success: true, data: data, message: ''};
}

export async function getParticipantQuestionData(contestId: number, participantId: number) {
  const {data, error} = await supabase
    .rpc('get_participant_questions', {
      contest_id: contestId,
      participant_id: participantId
    })
    .select('question_number, question_text, correct_answer, chosen_answer, total_score, max_score')

  if (error) {
    return {success: false, message: 'Server error'};
  }

  return {success: true, data: data, message: ''};
}

export async function removeParticipantStrike(participantId: number) {
  const {error} = await supabase
    .rpc('remove_participant_strike', {
      participant_id: participantId
    })

  if (error) {
    return {success: false, message: 'Server error'};
  }

  return {success: true, message: ''};
}

export async function resetParticipantStrikes(participantId: number) {
  const {error} = await supabase
    .rpc('reset_participant_strikes', {
      participant_id: participantId
    })

  if (error) {
    return {success: false, message: 'Server error'};
  }

  return {success: true, message: ''};
}