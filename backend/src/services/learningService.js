const { TrainingModule, QuizAttempt, ModuleProgress } = require('../models/Training');
const Quiz = require('../models/Quiz');
const Gamification = require('../models/Gamification');
const { awardPoints } = require('./gamificationService');

function normalizeQuestions(questions = []) {
  return questions.map((question, index) => ({
    question: question.question,
    options: question.options || [],
    correctAnswer: Number.isInteger(question.correctAnswer)
      ? question.correctAnswer
      : Number(question.answerIndex ?? 0),
  }));
}

async function ensureQuizForModule(module) {
  let quiz = await Quiz.findOne({ moduleId: module._id });
  if (quiz) return quiz;

  const fallbackQuestions = module.quizQuestions?.length > 0
    ? module.quizQuestions
    : TrainingModule.getFallbackQuizzes(module.category);

  quiz = await Quiz.create({
    moduleId: module._id,
    questions: normalizeQuestions(fallbackQuestions),
  });

  return quiz;
}

function serializeModule(module, options = {}) {
  const { progress, attempt, quiz } = options;

  return {
    id: module._id.toString(),
    title: module.title,
    description: module.description,
    contentType: module.contentType,
    contentUrl: module.contentUrl,
    category: module.category,
    difficulty: module.difficulty || 'beginner',
    createdAt: module.createdAt,
    thumbnailUrl: module.thumbnailUrl,
    durationMins: module.durationMins,
    pointsReward: module.pointsReward,
    completed: Boolean(progress || attempt?.passed),
    quizId: quiz?._id?.toString(),
    score: attempt?.score ?? null,
    pointsEarned: progress?.pointsEarned ?? attempt?.pointsEarned ?? 0,
    visualSteps: module.visualSteps || [],
    realLifeExamples: module.realLifeExamples || [],
    dos: module.dos || [],
    donts: module.donts || [],
    quickTips: module.quickTips || [],
    task: module.task || null,

    title_hi: module.title_hi,
    description_hi: module.description_hi,
    content_type: module.contentType,
    content_url: module.contentUrl,
    thumbnail_url: module.thumbnailUrl,
    points_reward: module.pointsReward,
    duration_mins: module.durationMins,
    visual_steps: module.visualSteps || [],
    real_life_examples: module.realLifeExamples || [],
    quick_tips: module.quickTips || [],
    quiz_questions: quiz?.questions?.map((question) => ({
      question: question.question,
      options: question.options || [],
    })) || [],
  };
}

async function listLearningModules(userId, category) {
  const filter = { isActive: true };
  if (category) filter.category = category;

  const [modules, attempts, progressRows, quizzes] = await Promise.all([
    TrainingModule.find(filter).sort({ sortOrder: 1, createdAt: 1 }).lean(),
    QuizAttempt.find({ userId }).sort({ createdAt: -1 }).lean(),
    ModuleProgress.find({ userId, completed: true }).lean(),
    Quiz.find({}).lean(),
  ]);

  const attemptMap = new Map();
  attempts.forEach((attempt) => {
    const key = attempt.moduleId.toString();
    if (!attemptMap.has(key)) attemptMap.set(key, attempt);
  });

  const progressMap = new Map(progressRows.map((row) => [row.moduleId.toString(), row]));
  const quizMap = new Map(quizzes.map((quiz) => [quiz.moduleId.toString(), quiz]));

  return modules.map((module) =>
    serializeModule(module, {
      progress: progressMap.get(module._id.toString()),
      attempt: attemptMap.get(module._id.toString()),
      quiz: quizMap.get(module._id.toString()),
    })
  );
}

async function getLearningModule(moduleId, userId) {
  const module = await TrainingModule.findOne({ _id: moduleId, isActive: true }).lean();
  if (!module) return null;

  const [progress, attempt, existingQuiz] = await Promise.all([
    ModuleProgress.findOne({ userId, moduleId, completed: true }).lean(),
    QuizAttempt.findOne({ userId, moduleId }).sort({ createdAt: -1 }).lean(),
    Quiz.findOne({ moduleId }).lean(),
  ]);

  const quiz = existingQuiz || await ensureQuizForModule(module);
  return serializeModule(module, { progress, attempt, quiz });
}

async function getQuizByModule(moduleId, userId) {
  const module = await TrainingModule.findOne({ _id: moduleId, isActive: true });
  if (!module) return null;

  const quiz = await ensureQuizForModule(module);
  const attempt = await QuizAttempt.findOne({
    userId,
    $or: [{ quizId: quiz._id }, { moduleId: module._id }],
  }).sort({ createdAt: -1 }).lean();

  return {
    quizId: quiz._id.toString(),
    moduleId: module._id.toString(),
    title: module.title,
    description: module.description,
    category: module.category,
    difficulty: module.difficulty || 'beginner',
    totalQuestions: quiz.questions.length,
    questions: quiz.questions.map((question, index) => ({
      id: index,
      question: question.question,
      options: question.options || [],
    })),
    latestAttempt: attempt
      ? {
          quizId: attempt.quizId?.toString(),
          score: attempt.score,
          totalQuestions: attempt.totalQuestions,
          passed: attempt.passed,
          completedAt: attempt.completedAt || attempt.createdAt,
        }
      : null,
  };
}

function calculateQuizPoints(score, totalQuestions) {
  const basePoints = 10;
  const percentage = totalQuestions > 0 ? score / totalQuestions : 0;
  let bonusPoints = 0;

  if (percentage >= 1) bonusPoints = 10;
  else if (percentage >= 0.8) bonusPoints = 5;

  return { basePoints, bonusPoints, totalPoints: basePoints + bonusPoints };
}

async function submitQuiz(userId, payload) {
  const moduleId = payload.moduleId || payload.module_id;
  const incomingAnswers = payload.answers;

  if (!moduleId || !incomingAnswers || typeof incomingAnswers !== 'object') {
    return { status: 400, error: 'moduleId and answers are required' };
  }

  const module = await TrainingModule.findOne({ _id: moduleId, isActive: true });
  if (!module) return { status: 404, error: 'Module not found' };

  const quiz = await ensureQuizForModule(module);
  const existingAttempt = await QuizAttempt.findOne({
    userId,
    $or: [{ quizId: quiz._id }, { moduleId: module._id }],
  }).lean();
  if (existingAttempt) {
    return {
      status: 409,
      error: 'Quiz already submitted',
      data: await buildQuizResult(existingAttempt, quiz, module, true),
    };
  }

  const answers = Array.isArray(incomingAnswers)
    ? Object.fromEntries(incomingAnswers.map((value, index) => [index, value]))
    : incomingAnswers;

  let score = 0;
  const review = quiz.questions.map((question, index) => {
    const selectedAnswer = Number(answers[index]);
    const correctAnswer = Number(question.correctAnswer);
    const isCorrect = selectedAnswer === correctAnswer;
    if (isCorrect) score += 1;

    return {
      question: question.question,
      options: question.options || [],
      selectedAnswer,
      correctAnswer,
      isCorrect,
    };
  });

  const totalQuestions = quiz.questions.length;
  const passed = totalQuestions > 0 ? score >= Math.ceil(totalQuestions * 0.6) : false;
  const { totalPoints, basePoints, bonusPoints } = calculateQuizPoints(score, totalQuestions);

  const attempt = await QuizAttempt.create({
    userId,
    moduleId: module._id,
    quizId: quiz._id,
    score,
    totalQuestions,
    passed,
    pointsEarned: totalPoints,
    answers,
    completedAt: new Date(),
  });

  await ModuleProgress.findOneAndUpdate(
    { userId, moduleId: module._id },
    {
      $set: {
        completed: true,
        pointsEarned: totalPoints,
        completedAt: new Date(),
      },
    },
    { new: true, upsert: true }
  );

  const previousPassed = await QuizAttempt.findOne({
    userId,
    moduleId: module._id,
    passed: true,
    _id: { $ne: attempt._id },
  });

  const pointsToAward = (passed && !previousPassed) ? totalPoints : 0;
  if (pointsToAward > 0) {
    await awardPoints(userId, 'quiz_passed', pointsToAward);
  }

  return {
    status: 200,
    data: {
      attemptId: attempt._id.toString(),
      quizId: quiz._id.toString(),
      moduleId: module._id.toString(),
      moduleTitle: module.title,
      score,
      totalQuestions,
      passed,
      answers,
      review,
      pointsAwarded: totalPoints,
      basePoints,
      bonusPoints,
      completedAt: attempt.completedAt,
    },
  };
}

async function buildQuizResult(attempt, quiz, module, alreadySubmitted = false) {
  const storedAnswers = attempt.answers || {};
  const review = quiz.questions.map((question, index) => {
    const selectedAnswer = Number(storedAnswers[index]);
    const correctAnswer = Number(question.correctAnswer);
    return {
      question: question.question,
      options: question.options || [],
      selectedAnswer,
      correctAnswer,
      isCorrect: selectedAnswer === correctAnswer,
    };
  });

  const { basePoints, bonusPoints, totalPoints } = calculateQuizPoints(
    attempt.score || 0,
    attempt.totalQuestions || quiz.questions.length
  );

  return {
    attemptId: attempt._id.toString(),
    quizId: attempt.quizId?.toString() || quiz._id.toString(),
    moduleId: module._id.toString(),
    moduleTitle: module.title,
    score: attempt.score || 0,
    totalQuestions: attempt.totalQuestions || quiz.questions.length,
    passed: Boolean(attempt.passed),
    answers: storedAnswers,
    review,
    pointsAwarded: attempt.pointsEarned ?? totalPoints,
    basePoints,
    bonusPoints,
    completedAt: attempt.completedAt || attempt.createdAt,
    alreadySubmitted,
  };
}

async function getQuizResult(moduleId, userId) {
  const module = await TrainingModule.findOne({ _id: moduleId, isActive: true });
  if (!module) return null;

  const quiz = await ensureQuizForModule(module);
  const attempt = await QuizAttempt.findOne({
    userId,
    $or: [{ quizId: quiz._id }, { moduleId: module._id }],
  }).sort({ createdAt: -1 });
  if (!attempt) return null;

  return buildQuizResult(attempt, quiz, module);
}

async function getUserProgress(userId) {
  const [totalModules, completedModules, attempts, gamification] = await Promise.all([
    TrainingModule.countDocuments({ isActive: true }),
    ModuleProgress.countDocuments({ userId, completed: true }),
    QuizAttempt.find({ userId }).sort({ completedAt: -1, createdAt: -1 }).lean(),
    Gamification.findOne({ userId }).lean(),
  ]);

  const quizzesCompleted = attempts.length;
  const completionPercentage = totalModules > 0
    ? Math.round((completedModules / totalModules) * 100)
    : 0;

  return {
    totalModules,
    completedModules,
    completionPercentage,
    quizzesCompleted,
    totalPoints: gamification?.totalPoints || 0,
    level: gamification?.level || 1,
    badges: gamification?.badges || [],
    quizzesPassed: gamification?.quizzesPassed || 0,
    streakDays: gamification?.streakDays || 0,
    recentQuizzes: attempts.slice(0, 10).map((attempt) => ({
      moduleId: attempt.moduleId?.toString(),
      quizId: attempt.quizId?.toString(),
      score: attempt.score,
      totalQuestions: attempt.totalQuestions,
      passed: attempt.passed,
      pointsEarned: attempt.pointsEarned,
      completedAt: attempt.completedAt || attempt.createdAt,
    })),

    total_modules: totalModules,
    completed_modules: completedModules,
    completion_percentage: completionPercentage,
    quizzes_completed: quizzesCompleted,
    total_points: gamification?.totalPoints || 0,
    quizzes_passed: gamification?.quizzesPassed || 0,
    streak_days: gamification?.streakDays || 0,
    recent_quizzes: attempts.slice(0, 10).map((attempt) => ({
      moduleId: attempt.moduleId,
      quizId: attempt.quizId,
      score: attempt.score,
      totalQuestions: attempt.totalQuestions,
      passed: attempt.passed,
      pointsEarned: attempt.pointsEarned,
      completedAt: attempt.completedAt || attempt.createdAt,
    })),
  };
}

async function updateGamification(userId, payload = {}) {
  const action = payload.action;
  const { POINTS_MAP } = require('./gamificationService');

  if (!action || !POINTS_MAP[action]) {
    return { status: 400, error: 'Invalid or unsupported gamification action.' };
  }

  // Prevent users from granting themselves arbitrary points
  const result = await awardPoints(userId, action);
  const profile = await Gamification.findOne({ userId }).lean();

  return {
    status: 200,
    data: {
      awarded: result?.points || 0,
      newBadges: result?.newBadges || [],
      level: result?.level || profile?.level || 1,
      gamification: profile || {},
    },
  };
}

module.exports = {
  getLearningModule,
  getQuizByModule,
  getQuizResult,
  getUserProgress,
  listLearningModules,
  submitQuiz,
  updateGamification,
};
