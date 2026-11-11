// Topic Diversity Scorer — attenuates each additional post on a topic that already appears
// higher in the ranking, so near-identical posts don't run together. Topics are learned
// (k-means over post embeddings, refit weekly: private.post_topics). Same shape as the author
// scorer, gentler decay; a post without a topic yet is left alone.

import { cfg } from '../lib/config.ts';
import { repeatPenalty, Scorer } from './types.ts';

export const topicDiversityScorer: Scorer = {
  name: 'topicDiversity',
  apply(candidates) {
    candidates.sort((a, b) => b.score - a.score);
    const countByTopic = new Map<number, number>();
    for (const c of candidates) {
      const topic = c.features.topic;
      if (topic == null) continue;
      const n = countByTopic.get(topic) ?? 0;
      if (n > 0) {
        const penalty = repeatPenalty(c.score, Math.pow(cfg().topicDiversityDecay, n), cfg().diversityFloor);
        c.parts.topicRepeat = -penalty;
        c.score -= penalty;
      }
      countByTopic.set(topic, n + 1);
    }
  },
};
