export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { shopName, keywords, answersText, starRating } = req.body;
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'API key is not configured on the server.' });
    }

    const systemPrompt = `あなたはプロのライターであり、お店を訪れた「大満足したお客様」です。以下のアンケート回答をもとに、Googleマップに投稿するための自然で高評価な口コミ文章（レビュー）を代筆してください。

【厳格なルール】
1. さくら（やらせ）感を出さない。あくまで「一般のお客様」としての自然な文体（です/ます調、あるいは親しみやすいトーン）にすること。
2. 500文字〜800文字程度の充実した文章にすること。短い文章は不可。
3. アンケートで回答された良かった点（料理、接客、雰囲気など）を具体的に褒めること。
4. 提供された「MEOキーワード」を、不自然にならないように文章内に1〜2回だけさりげなく散りばめること。
5. 一切の見出し（**導入** など）や箇条書きを使わず、一つのつながった文章として出力すること。
6. お店への感謝と「また来たい」という再訪意欲で締めくくること。`;

    const userPrompt = `【店舗名】: ${shopName || 'お店'}
【MEOキーワード（可能なら自然に含める）】: ${keywords ? keywords.join(', ') : 'なし'}
【お客様の星評価】: ${starRating || 5}

【お客様のアンケート回答内容】
${answersText}

上記の回答をもとに、お店で体験した素晴らしい時間を振り返るような、自然で感情のこもった口コミ文章を作成してください。「はい、作成します」などの返答は不要です。口コミ本文のみを出力してください。`;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.7,
                max_tokens: 1500
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || 'OpenAI API request failed');
        }

        res.status(200).json({ reply: data.choices[0].message.content });
    } catch (error) {
        console.error("OpenAI Route Error:", error);
        res.status(500).json({ error: error.message });
    }
}
