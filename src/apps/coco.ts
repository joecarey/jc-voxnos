// Coco — demo customer experience survey.
// 3-question scripted flow: satisfaction scale, recommendation yes/no, open feedback.

import { SurveyApp } from '../engine/survey-app.js';

export class CocoSurvey extends SurveyApp {
  constructor() {
    super({
      id: 'coco',
      name: 'Coco',
      greeting: 'Hi, thanks for taking a moment to share your feedback. I have three quick questions.',
      closing: 'Thanks for completing the survey. Your feedback is appreciated. Goodbye.',
      retries: [
        "I didn't catch your answer. Could you repeat that?",
        "Sorry, I missed that. Could you say it again?",
        "I didn't hear anything. Please go ahead.",
      ],
      questions: [
        {
          label: 'satisfaction',
          text: 'How would you rate your overall experience on a scale of 1 to 5?',
          type: 'scale',
        },
        {
          label: 'recommend',
          text: 'Would you recommend us to a friend?',
          type: 'yes_no',
        },
        {
          label: 'feedback',
          text: 'Is there anything else you would like to share?',
          type: 'open',
        },
      ],
    });
  }
}
