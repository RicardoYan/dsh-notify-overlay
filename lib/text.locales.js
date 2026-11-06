/**
 * Translations for the notification titles and bodies.
 *
 * Keys are the English text itself where the string has no interpolation, so a
 * lookup site stays a single `L(zh, en, X.title)` call; the two that carry a
 * runtime value are exported as functions instead.
 */
export const X = {
    approvalTitle: {
        de: 'Genehmigung erforderlich',
        es: 'Se requiere aprobación',
        fr: 'Approbation requise',
        ja: '承認が必要です',
        pt: 'Aprovação necessária',
        ru: 'Требуется одобрение',
    },
    approvalBody: {
        de: 'Fordert eine Berechtigung an',
        es: 'Solicita autorización',
        fr: 'Demande une autorisation',
        ja: '権限を要求しています',
        pt: 'Solicita autorização',
        ru: 'Запрашивает разрешение',
    },
    questionTitle: {
        de: 'Ihre Antwort wird benötigt',
        es: 'Se necesita tu respuesta',
        fr: 'Votre réponse est attendue',
        ja: '回答が必要です',
        pt: 'Sua resposta é necessária',
        ru: 'Нужен ваш ответ',
    },
    questionBody: {
        de: 'Der Agent hat eine Frage an Sie',
        es: 'El agente tiene una pregunta para ti',
        fr: 'L\'agent a une question pour vous',
        ja: 'エージェントから質問があります',
        pt: 'O agente tem uma pergunta para você',
        ru: 'У агента есть вопрос',
    },
    subagentsDoneTitle: {
        de: 'Alle Subagenten fertig',
        es: 'Todos los subagentes terminaron',
        fr: 'Tous les sous-agents ont terminé',
        ja: 'サブエージェントがすべて完了',
        pt: 'Todos os subagentes terminaram',
        ru: 'Все субагенты завершили работу',
    },
    turnDoneTitle: {
        de: 'Runde abgeschlossen',
        es: 'Turno completado',
        fr: 'Tour terminé',
        ja: 'ターン完了',
        pt: 'Turno concluído',
        ru: 'Ход завершён',
    },
    turnDoneBody: {
        de: 'Der Agent ist im Leerlauf',
        es: 'El agente está inactivo',
        fr: 'L\'agent est au repos',
        ja: 'エージェントは待機中です',
        pt: 'O agente está ocioso',
        ru: 'Агент простаивает',
    },
    subagentFailedTitle: {
        de: 'Subagent fehlgeschlagen',
        es: 'Subagente falló',
        fr: 'Échec du sous-agent',
        ja: 'サブエージェントでエラー',
        pt: 'Subagente falhou',
        ru: 'Ошибка субагента',
    },
    runFailedTitle: {
        de: 'Ausführung fehlgeschlagen',
        es: 'La ejecución falló',
        fr: 'Échec de l\'exécution',
        ja: '実行に失敗',
        pt: 'A execução falhou',
        ru: 'Ошибка выполнения',
    },
    sessionClosedTitle: {
        de: 'Sitzung beendet',
        es: 'Conversación cerrada',
        fr: 'Conversation fermée',
        ja: '会話を終了しました',
        pt: 'Conversa encerrada',
        ru: 'Разговор завершён',
    },
};
