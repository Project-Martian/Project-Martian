"""Bounded data contracts for the model, browser and read-only MCP tools."""
from datetime import date
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_RECORDS = 64
RecordIds = Annotated[list[Annotated[str, Field(min_length=1, max_length=80)]], Field(max_length=MAX_RECORDS)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Turn(StrictModel):
    question: Annotated[str, Field(min_length=1, max_length=900)]
    answer: Annotated[str, Field(max_length=1200)]
    record_ids: RecordIds


class AskInput(StrictModel):
    question: Annotated[str, Field(min_length=1, max_length=900)]
    history: Annotated[list[Turn], Field(max_length=6)] = []


class CatalogFilter(StrictModel):
    scope: Literal['agents', 'all']
    start_date: str
    end_date: str

    @field_validator('start_date', 'end_date')
    @classmethod
    def iso_date(cls, value):
        if value and date.fromisoformat(value).isoformat() != value:
            raise ValueError('Use YYYY-MM-DD or an empty string for no bound')
        return value


class Section(StrictModel):
    # Hard payload limits allow normal prose variation; short output is requested
    # in the prompt and bounded overall by the model's output-token budget.
    heading: Annotated[str, Field(min_length=1, max_length=200)]
    text: Annotated[str, Field(min_length=1, max_length=2000)]
    record_ids: Annotated[RecordIds, Field(min_length=1)]


class FinalAnswer(StrictModel):
    status: Literal['answered', 'no_matches', 'clarification']
    answer_kind: Literal['listing', 'explanation', 'coverage']
    intro: Annotated[str, Field(min_length=1, max_length=1000)]
    record_ids: RecordIds
    sections: Annotated[list[Section], Field(max_length=8)]


class ReviewDecision(StrictModel):
    reason: Annotated[str, Field(max_length=1200)]
    decision: Literal['allow', 'reject']


class RequestPlan(StrictModel):
    decision: Literal['allow', 'reject', 'clarification']
    interpretation: Annotated[str, Field(max_length=900, description='Standalone question preserving the user subject and any stated period, resolved using history and the archive record index.')] = ''
    answer_kind: Annotated[Literal['listing', 'explanation', 'coverage'] | None,
                          Field(description='coverage for questions about the archive itself, its freshness, date coverage or capabilities; listing for incident inventories/counts; explanation for incident facts, causes, impact or lessons. Null for rejection.')] = None
    scope: Literal['agents', 'all'] | None = None
    start_date: str | None = None
    end_date: str | None = None
    clarification: Annotated[str, Field(max_length=400)] = ''

    @model_validator(mode='after')
    def action_contract(self):
        # Rejections do not need fictional retrieval arguments. Accepted incident
        # requests MUST provide every bound explicitly; missing never means broad.
        if self.decision == 'allow':
            if not self.interpretation:
                raise ValueError('Accepted requests require a standalone question')
            if self.answer_kind is None:
                raise ValueError('Accepted requests require an answer kind')
            if self.answer_kind != 'coverage':
                CatalogFilter(scope=self.scope, start_date=self.start_date, end_date=self.end_date)
        if self.decision == 'clarification' and not self.clarification:
            raise ValueError('Clarification requires a question')
        return self


class RecordSelection(StrictModel):
    selection_mode: Literal['all_catalog', 'selected_ids']
    record_ids: RecordIds


class CoverageAnswer(StrictModel):
    intro: Annotated[str, Field(min_length=1, max_length=900)]


class Explanation(StrictModel):
    sections: Annotated[list[Section], Field(min_length=1, max_length=8)]
