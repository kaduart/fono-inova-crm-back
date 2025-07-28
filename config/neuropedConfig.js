export default {
    sessionDuration: 45, // minutos
    defaultFields: [
      'developmentalHistory',
      'neurologicalExam',
      'seizureFrequency'
    ],
    templates: {
      initialAssessment: {
        sections: [
          {
            title: 'Histórico Desenvolvimental',
            fields: [
              { 
                name: 'milestones', 
                type: 'milestone-grid',
                milestones: ['sorriso social', 'sentar', 'andar', 'primeiras palavras']
              }
            ]
          }
        ]
      }
    }
  };